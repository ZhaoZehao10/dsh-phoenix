# 安装 / 卸载

[English](INSTALL.md) | **中文版**

适用：Windows 10/11 · DeepSeek Harness 桌面端 **0.2.1-rc.3** 或 **0.2.1-rc.5**（已验证列表）。

## 前置条件

- 已安装 DeepSeek Harness（默认路径 `%LOCALAPPDATA%\Programs\DeepSeek Harness`，可用 `DSH_INSTALL_DIR` 覆盖）。
- **完全退出 DSH**（托盘图标 → 退出）——运行中 `app.asar` 被锁，无法替换。
- 不需要单独安装 Node.js：脚本使用 DSH 自带的运行时。

## 第 1 步 — 用你自己的安装重建补丁

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" tooling\patch-asar.mjs
```

读取你本机的 `app.asar`，校验 Electron fuse、asar 数据基准与边界，输出 `work/app.asar.patched`。重复运行是安全的（幂等）。

## 第 2 步 — 跑测试（推荐）

```powershell
$node = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
& $node tooling\campaign\test_asar_structure.mjs
& $node tooling\campaign\test_asar_reference.mjs
& $node tooling\campaign\test_handler_unit.mjs
& $node tooling\campaign\test_crash_report_mem.mjs
& $node tooling\campaign\test_handler_fuzz.mjs 100
```

全绿说明补丁适用于你的构建。

## 第 3 步 — 安装

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-patched.ps1
```

安装器按事务执行：安全闸 → 备份 → 替换 → 换装后自检 → **BOOTCHECK**（用标记环境变量真启动一次应用）→ 任一步失败自动回滚。成功会打印 `✅ BOOTCHECK 通过`（应用会闪一下，属正常）。

## 卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\revert-asar.ps1
```

恢复 `resources\app.asar.bak-*` 中最新的备份。

## DSH 官方更新之后

官方更新会覆盖 `app.asar`（预期行为）。之后：

1. 先跑兼容检查：`node tooling\check-version-compat.mjs`
2. 锚点命中 → 重新执行第 1、3 步
3. 锚点未命中 → 上游改了这段代码：要么官方已自行修复（停止打补丁），要么处理器位置变了（更新 `tooling\patch-asar.mjs` 的 `OLD_HANDLER`）

## 排障

| 现象 | 含义 / 处理 |
|---|---|
| `❌ 安装版本是 …，未在已验证列表` | 新的 DSH 构建。跑 `check-version-compat.mjs` + 测试全套；全绿后把版本加入 `DSH_ALLOWED_VERSIONS` 或改 `scripts/install-patched.ps1` 的允许列表。 |
| `❌ 该构建启用了 asar 完整性校验` | 该构建启用了 `EnableEmbeddedAsarIntegrityValidation`，补丁 asar 会被拒绝。改用源码构建。 |
| `❌ app.asar 当前被占用` | DSH 仍在运行（或刚退出未释放）。完全退出后重试。 |
| `❌ 未找到预期的 render-process-gone 处理器原文` | 上游改了处理器。见「DSH 官方更新之后」。 |
