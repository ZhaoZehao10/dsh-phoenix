# 桌面端渲染器 OOM → 应用整体退出：恢复补丁 + 事件窗口字节预算

[English](overview.md) | **中文版**

DeepSeek Harness 桌面端（Electron 外壳 `@deepseek-ai/dsh-desktop`）目前会把**任何**渲染器死亡
（包括 `oom`）升级为致命弹窗（`reportFatal`），导致整个应用退出：进行中的回合被打断、
后台任务丢失、用户必须手动重启。

本方案提出两项改动及配套证据：

| 补丁 | 作用 |
|---|---|
| `01-desktop-renderer-recovery.patch` | 渲染器死亡是**可恢复状态**：会话日志在磁盘上持久化、Host 仍健康，重载页面即可恢复视图。重载有界（60 秒内最多 2 次），因此"一加载必崩"的会话仍会升级为诊断而不是无限重载。每次恢复写入 `logs/renderer-recovery.log`。 |
| `02-bounded-event-window.patch` | `MutableSessionEventSource` 的常驻事件窗口每翻一页历史就追加、从不收缩（`loadOlder()` 每次都永久前置）。本补丁把窗口限制为字节预算并保留尾部——这是超长会话下渲染器堆耗尽的根因。 |

两个补丁对上游 `master` 干净适用（2026-10-28 验证于 `f3803c96`，0.2.2-alpha.2）。

## 为什么我们认为这就是现场故障

在一台 32 GB Windows 机器上，`DeepSeek Harness.exe` 以
`Desktop renderer exited: oom` 死亡（崩溃日志已保留）。真正定位到原因的诊断路径：

1. **Windows 资源耗尽侦测器事件**（`System` 日志，Event ID 2004）在崩溃前触发两次：
   `SystemCommitCharge 127.7 GiB / SystemCommitLimit 127.9 GiB (99.8%)`，物理内存 99.4%，
   占用最高的进程是 `python.exe` 测试进程与一个 WSL2 虚拟机——**渲染器不在前四名**。
   渲染器在第二次事件后 8 秒死亡。
2. 在另一台机器（14.7 GB 内存）上，用真实失败会话构建了复现：
   **原始 164 MB / 60,858 事件 / 22 天**，常驻事件窗口随 `loadOlder()` 增长且从不收缩
   （实测无界 `+169 MB` vs 有界 `+46 MB`；有界窗口峰值 `164.25 MB → 47.89 MB`）。

因此有两种独立的成因会得到同一个 `reason: 'oom'`：

| 类别 | 机理 | 判别特征 | 修复 |
|---|---|---|---|
| A | 渲染器 V8 堆被无界常驻事件窗口耗尽 | 单会话远超其它（10 倍以上）；渲染器 PrivateMB 爬到 2–4 GB 后死亡；短会话不增长 | 补丁 02（根因）、补丁 01（止损） |
| B | 进程级内存核算（分区 / 指针压缩笼） | 进程内存远低于物理内存仍被杀 | 部分缓解 |
| C | 真实 OS 内存压力（提交上限） | 提交量 ≈ 上限；系统整体卡顿；其它应用也异常 | 非渲染器侧 |

`reason: 'oom'` 覆盖以上三类——**仅凭崩溃原因字符串无法区分**。
建议先做资源耗尽侦测器检查（见下文"诊断"一节），再归罪渲染器。

## 补丁 01 改了什么

```ts
window.webContents.on('render-process-gone', (_event, details) => {
  navigation = undefined
  if (quitting || window.isDestroyed() || details.reason === 'clean-exit') return
  if (Date.now() - lastRecoveryAt > RECOVERY_BUDGET_RESET_MS) rendererRecoveries = 0
  const recoverable = RECOVERABLE_RENDERER_EXITS.has(details.reason)
    && rendererRecoveries < MAX_RENDERER_RECOVERIES
  if (!recoverable) {
    reportFatal(new Error(`Desktop renderer exited: ${details.reason}`), 'renderer')
    return
  }
  rendererRecoveries += 1
  lastRecoveryAt = Date.now()
  logRendererRecovery(`renderer exited (${details.reason}); reloading page (recovery ${rendererRecoveries}/${MAX_RENDERER_RECOVERIES})`)
  setTimeout(() => {
    if (quitting || window.isDestroyed()) return
    try { window.reload() } catch (error) { reportFatal(error, 'renderer') }
  }, RENDERER_RECOVERY_DELAY_MS)
})
```

设计要点：

- **有界**：60 秒窗口内最多 2 次重载，随后升级到既有 `reportFatal`——
  每次加载都崩的会话仍会产出诊断，而不是无限重载。
- **时间重置预算**：间隔超过 60 秒的孤立崩溃不互相占用额度；只有连环崩才会耗尽。
- **可审计**：每次恢复追加到 `logs/renderer-recovery.log`
  （时间戳、原因、尝试序号）。日志失败绝不影响恢复。
- **正常使用无行为变化**：唯一可观察的差异是渲染器死亡后会重载，而不是杀死应用。

## 诊断 `oom` 崩溃（在归罪渲染器之前）

```powershell
Get-WinEvent -FilterHashtable @{LogName='System';
  ProviderName='Microsoft-Windows-Resource-Exhaustion-Detector'} |
  ForEach-Object { $_.TimeCreated; $_.Message }
```

每条事件携带 `SystemCommitLimit`、`SystemCommitCharge`、`PhysicalMemoryUsage`、
进程数和前四名提交内存消耗者。如果提交量已到上限、而渲染器不在前几名，
说明渲染器是系统内存耗尽的**受害者**——崩溃是真实的，但根因不在渲染器侧。

## 测试证据

`tests/handler-semantics.mjs` 从 `apps/desktop/src/main.ts` **原样抽取**补丁段并用桩驱动
（Node ≥ 23.6 原生类型剥离，无需构建步骤）：

```
$ git apply patches/01-desktop-renderer-recovery.patch
$ node tests/handler-semantics.mjs
  PASS  C1 oom -> reload 1x, no fatal
  PASS  C2 crashed -> reload
  PASS  C2b killed -> reload
  PASS  C7 destroyed window -> no-op
  PASS  C6 quitting -> no-op
  PASS  C3 clean-exit -> no-op
  PASS  C4 integrity-failure/launch-failed/abnormal-exit -> fatal, no reload
  PASS  C9 every recovery audited to renderer-recovery.log
PASS: all handler-semantics cases
```

`tests/bounded-event-window.mjs` + `tests/verify-scrollback-scenario.cjs`
用真实 60,858 事件会话画像验证补丁 02（`tests/session-profile.json`，仅 `{t, b, s}` 形状，无消息内容）：

```
$ node tests/verify-scrollback-scenario.cjs tests/session-profile.json
peak after paging : 47.89 MB    RESULT: PASS
```

## 不构建源码、直接在本机应用

如果需要在官方发布前先修复已安装的桌面端，可以对 `app.asar` 做外科补丁：
头部 JSON 就地改写（数据区逐字节不动），补丁后的 `main.js` 追加到文件末尾——
`@electron/asar` 4.3.1 可验证结果。工具见本仓库；注意：下一次官方更新会覆盖补丁，
更新后应重新验证。

## 请求讨论

1. `reason: 'oom'`（以及 `crashed`、`killed`）是否应触发有界页面重载而不是致命弹窗？
   我们认为窗口是持久状态之上的纯视图，所以答案是肯定的——但希望你们审视预算边界
   （2 次/60 秒、时间重置预算）。
2. 常驻事件窗口是否应按字节预算默认有界（补丁 02）？
   现场数据表明 22 天会话原始占用 164 MB；有界窗口保持同样体验且约 48 MB。
3. 上游是否接受一项诊断改进：把内存计数器（`os.freemem/totalmem`、`process.memoryUsage()`、
   Host 子进程 RSS）附加到渲染器崩溃报告？当前的崩溃报告没有任何内存字段，
   这正是当初定位现场故障必须依赖 Windows 事件日志的原因。
