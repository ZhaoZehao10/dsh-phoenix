# DSH 渲染器 OOM 崩溃 · 修复方案与测试工具包

[English](README.md) | **中文版**

解决 `Desktop renderer exited: oom` 导致整个应用退出、会话与后台任务丢失的问题。

> 状态：**v6**，已在 dsh-desktop 0.2.1-rc.5（Windows）真机验证。以 `app.asar` 外科补丁方式安装；给上游的源码补丁在 [`patches/`](patches/)。
>
> 讨论：[上游](https://github.com/deepseek-ai/deepseek-harness/discussions/12149) · [本仓库](https://github.com/ZhaoZehao10/dsh-phoenix/discussions/1)

**先读 [docs/INSTALL.zh-CN.md](docs/INSTALL.zh-CN.md)** —— 前置检查、三步上手、测试套件与卸载说明。

## 包内容一览

```
config/resolve.mjs      ← 唯一路径来源（自动探测本机安装目录，无需改代码）
tooling/
  patch-asar.mjs        ← 用你本机的 app.asar 现场重建补丁（含基准/边界/哈希自检）
  patch-asar-test.mjs   ← 隔离实验用的测试变体
  campaign/             ← 测试战役：100 轮随机模糊 + 结构 + 官方参照实现 + 语义 + 真值表
  rebase/               ← 上游迭代：抓 master 文件、重生成补丁
  check-version-compat.mjs ← DSH 升级后先跑这个（锚点命中检查）
scripts/
  install-patched.ps1   ← 换装（安全闸 → 备份 → 自检 → BOOTCHECK 真启动验证 → 失败自动回滚）
  revert-asar.ps1       ← 一键还原
  check-dsh-sessions.ps1 / retire-dsh-session.ps1 / set-pagefile-cap.ps1  ← 会话与内存卫生
patches/  tests/  docs/
```

## 三分钟验证它没坏

```powershell
$node = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
& $node tooling\patch-asar.mjs
& $node tooling\campaign\test_handler_fuzz.mjs 100
& $node tooling\campaign\test_asar_reference.mjs
```

三条都绿，说明补丁在你这台机器上也是可用的。

## 方案要点（细节见 docs/diagnosis.md）

1. **恢复**：渲染器死亡（`oom`/`crashed`/`killed`）→ 250ms 后重载页面；60s 内最多 2 次
   （时间重置预算：隔久的孤立崩溃不互相占额度，连环崩仍会升级诊断窗）；每次恢复写
   `logs/renderer-recovery.log` 便于审计；崩溃报告新增 `--- memory snapshot (P-282) ---`
   （主进程 / 系统 / 渲染器最近心跳）。
2. **根因**：常驻事件窗口无界增长 ⟹ 按字节预算 + 尾部保留（实测峰值 164.25 → 47.89 MB）。
3. **归因方法**：`reason:'oom'` 覆盖三类故障（V8 堆耗尽 / 进程级核算 / 真实 OS 压力），
   判据是 Windows 资源耗尽侦测器的提交内存事件 + 渲染器自身水位，不是"还剩多少空闲内存"。

## 上游贡献

`patches/` 内的两个源码补丁对上游 `master` 干净适用（`git apply --check` 已验证）。
上游贡献尚待 maintainer 反馈；相关背景与证据见 `docs/diagnosis.md`。
