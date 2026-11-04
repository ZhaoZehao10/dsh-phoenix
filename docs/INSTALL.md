# Install / Uninstall

**English** | [中文版](INSTALL.zh-CN.md)

Target: Windows 10/11 · DeepSeek Harness desktop **0.2.1-rc.3** or **0.2.1-rc.5** (the validated list).

## Prerequisites

- DeepSeek Harness installed (default: `%LOCALAPPDATA%\Programs\DeepSeek Harness`; override with `DSH_INSTALL_DIR`).
- **Fully quit DSH** (tray icon → Quit) — the patched `app.asar` cannot be replaced while it is running.
- Node.js is not required separately: the scripts use the Node runtime bundled with DSH.

## Step 1 — rebuild the patch from your own install

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" tooling\patch-asar.mjs
```

This reads your own `app.asar`, verifies the Electron fuses, the asar data base, and the boundary, and writes `work/app.asar.patched`. Re-running it is safe (idempotent).

## Step 2 — run the test battery (recommended)

```powershell
$node = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
& $node tooling\campaign\test_asar_structure.mjs
& $node tooling\campaign\test_asar_reference.mjs
& $node tooling\campaign\test_handler_unit.mjs
& $node tooling\campaign\test_crash_report_mem.mjs
& $node tooling\campaign\test_handler_fuzz.mjs 100
```

All green ⟹ the patch is valid for your build.

## Step 3 — install

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-patched.ps1
```

The installer runs as a transaction: safety gates → backup → replace → post-swap self-check → **BOOTCHECK** (launches the app once with a marker environment variable) → automatic rollback on any failure. A successful run prints `✅ BOOTCHECK 通过` (the app flashes once — that is expected).

## Uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\revert-asar.ps1
```

Restores the newest `resources\app.asar.bak-*` backup.

## After a DSH update

Official updates replace `app.asar` (expected). Then:

1. Run the compatibility check: `node tooling\check-version-compat.mjs`
2. If the anchor hits → re-run Step 1 + Step 3.
3. If the anchor misses → upstream changed that code: either they fixed it (stop patching) or the handler moved (update `tooling\patch-asar.mjs`'s `OLD_HANDLER`).

## Troubleshooting

| Symptom | Meaning / fix |
|---|---|
| `❌ 安装版本是 …，未在已验证列表` | New DSH build. Run `check-version-compat.mjs` + the test battery; if green, add the version to `DSH_ALLOWED_VERSIONS` or edit the allow-list in `scripts/install-patched.ps1`. |
| `❌ 该构建启用了 asar 完整性校验` | The build enables `EnableEmbeddedAsarIntegrityValidation`; an asar patch would be rejected. Use a source build instead. |
| `❌ app.asar 当前被占用` | DSH is still running (or just exited). Quit it fully / retry after a few seconds. |
| `❌ 未找到预期的 render-process-gone 处理器原文` | Upstream changed the handler. See “After a DSH update”. |
