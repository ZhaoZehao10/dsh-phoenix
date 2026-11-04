# ★ P-282 v3：把「渲染器死亡恢复」补丁安装进 DeepSeek Harness（验证过的事务）。
#
# 流程：
#   ① DSH 必须已关闭（运行中文件被锁）
#   ② 版本核对（补丁按 0.2.1-rc.3 制作）
#   ③ 补丁文件自检（marker + 语法）
#   ④ 当前 asar 已打过补丁则跳过；否则备份（只备份一次）
#   ⑤ 替换 + 结构自检（语法/marker，失败回滚）
#   ⑥ BOOTCHECK：真启动一次补丁版应用 —— 应用内嵌的惰性自检钩子
#      （DSH_PATCH_BOOTCHECK）就绪后写标记文件并退出；失败自动回滚
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File .\install-patched.ps1
# 还原：powershell -NoProfile -ExecutionPolicy Bypass -File .\revert-asar.ps1
#
# 已知后果（如实告知）：
#   · 下次官方更新会覆盖本补丁（官方修复到位后本补丁自然作废 —— 期望行为）
#   · 更新后若官方仍未修，重跑 patch-asar.mjs + 本脚本即可

$ErrorActionPreference = 'Stop'
# 路径全部可移植：默认按当前用户/脚本位置推导，可用环境变量覆盖
$BundleRoot = Split-Path $PSScriptRoot -Parent
$Install = if ($env:DSH_INSTALL_DIR) { $env:DSH_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\DeepSeek Harness" }
$WorkDir = if ($env:DSH_WORK_DIR) { $env:DSH_WORK_DIR } else { Join-Path $BundleRoot "work" }
if (-not (Test-Path $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }
$Target  = Join-Path $Install "resources\app.asar"
$Patched = if ($env:DSH_PATCHED_ASAR) { $env:DSH_PATCHED_ASAR } else { Join-Path $WorkDir "app.asar.patched" }

Write-Host ''
Write-Host '  =============================================================='
Write-Host '  P-282 v6 渲染器死亡恢复补丁 · 安装（含启动自检）'
Write-Host '  =============================================================='

# ---- ① DSH 必须已关闭（以文件锁为准：进程枚举只是线索，锁探测才是事实）----
$exePath = Join-Path $Install "DeepSeek Harness.exe"
$all = @(Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue)
$cimPath = { param($procId) (Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue).ExecutablePath }
$samePath = @($all | Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).ExecutablePath -eq $exePath })
$zombies  = @($all | Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).ExecutablePath -eq $null })
$others   = @($all | Where-Object { ($zombies.Id -notcontains $_.Id) -and ($samePath.Id -notcontains $_.Id) })
if ($samePath.Count -gt 0) {
    Write-Host "  ❌ 本安装目录的 DeepSeek Harness 正在运行（$(($samePath | ForEach-Object { $_.Id }) -join ', ')）。" -ForegroundColor Red
    Write-Host '     ⟹ 请先完全退出 DSH（托盘图标 → 退出），再运行本脚本。'
    exit 1
}
if ($zombies.Count -gt 0) {
    # 实测坑：崩溃残留可能是「镜像已删」的僵尸（ExecutablePath 为空、杀不掉）——不持有本 asar，忽略
    Write-Host ("  ℹ️ 忽略 {0} 个镜像已删除的僵尸进程（不持有 app.asar，重启后自然消失）: {1}" -f $zombies.Count, (($zombies | ForEach-Object { $_.Id }) -join ', ')) -ForegroundColor DarkGray
}
if ($others.Count -gt 0) {
    # 其他安装位置的 DSH 进程不锁本目录的 asar（换装到副本/多安装场景）
    Write-Host ("  ℹ️ 另一安装位置有 {0} 个 DSH 进程在运行（不锁本目录 asar）: {1}" -f $others.Count, (($others | ForEach-Object { $_.Id }) -join ', ')) -ForegroundColor DarkGray
}
$locked = $false
try {
    $fs = [IO.File]::Open($Target, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [System.IO.FileShare]::Delete)
    $fs.Close()
} catch {
    Write-Host "  ❌ app.asar 当前被占用（$($_.Exception.Message.Split([char]10)[0])）。" -ForegroundColor Red
    Write-Host '     ⟹ 通常说明 DSH 仍在运行或刚退出未释放，稍等几秒重试。'
    exit 1
}
Write-Host '  ✅ DSH 未占用本目录 asar（锁探测通过）'

# ---- ② 版本核对 ----
$ver = (Get-Item (Join-Path $Install "DeepSeek Harness.exe")).VersionInfo.FileVersion
# 允许列表：补丁锚点已对以下编译产物逐一验证（patch-asar.mjs 的锚点校验是第二道闸）
# 新版本适配流程：跑 tooling/patch-asar.mjs + campaign 全套，绿了就把版本加进来（或设 DSH_ALLOWED_VERSIONS）
$allowed = if ($env:DSH_ALLOWED_VERSIONS) { $env:DSH_ALLOWED_VERSIONS -split ',' } else { @('0.2.1-rc.3', '0.2.1-rc.5') }
if ($allowed -notcontains $ver) {
    Write-Host "  ❌ 安装版本是 $ver，未在已验证列表（$($allowed -join ', ')）中。" -ForegroundColor Red
    Write-Host '     ⟹ 先重跑 patch-asar.mjs + campaign 全套测试；全绿后再把该版本加入允许列表'
    Write-Host '       （或临时设 $env:DSH_ALLOWED_VERSIONS = "$ver"，自担风险）。'
    exit 1
}
Write-Host "  ✅ 版本 $ver 在已验证列表中"

# ---- ③ 补丁文件自检 ----
if (-not (Test-Path $Patched)) {
    Write-Host "  ❌ 找不到补丁文件 $Patched" -ForegroundColor Red
    exit 1
}
$node = Join-Path $Install "resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
$checkJs = Join-Path $BundleRoot "scripts\lib\check-asar.cjs"
# asar 检查逻辑在 scripts/lib/check-asar.cjs（不用 node -e：PS5.1 剥双引号，实测踩过）
& $node $checkJs extract $Patched "$WorkDir\_install_check.mjs" | ForEach-Object { "  $_" }
if ($LASTEXITCODE -ne 0) { Write-Host '  ❌ 补丁文件自检失败' -ForegroundColor Red; exit 1 }
& $node --check "$WorkDir\_install_check.mjs"
if ($LASTEXITCODE -ne 0) { Write-Host '  ❌ 补丁文件语法无效' -ForegroundColor Red; exit 1 }
Write-Host '  ✅ 补丁文件自检通过（marker + 语法）'

# ---- ④ 已打过补丁则跳过；否则备份 ----
$currentVer = & $node $checkJs version $Target
$patchedVer = & $node $checkJs version $Patched
if ($currentVer -eq $patchedVer) {
    Write-Host "  ℹ️ 当前已安装补丁 $currentVer —— 与待安装版本一致，无需重复安装。"
    exit 0
}
if ($currentVer -ne 'none') {
    Write-Host "  ℹ️ 检测到已安装旧版补丁 $currentVer → 将升级到 $patchedVer（原版备份保持不动）。"
}
$backup = Get-ChildItem (Join-Path $Install "resources") -Filter "app.asar.bak-*" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $backup) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $bakPath = Join-Path $Install "resources\app.asar.bak-rc3-$stamp"
    Copy-Item $Target $bakPath
    Write-Host "  ✅ 已备份原版 → app.asar.bak-rc3-$stamp"
} else {
    Write-Host "  ℹ️ 已存在备份 $($backup.Name)（不重复备份，避免备份到补丁版）"
    $bakPath = $backup.FullName
}

# ---- ⑤ 替换 + 结构自检 ----
Copy-Item $Patched $Target -Force
Write-Host '  ✅ 已替换 app.asar'
& $node $checkJs extract $Target "$WorkDir\_installed_main.mjs" | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host '  ❌ 安装后自检失败：marker 缺失！正在回滚…' -ForegroundColor Red
    Copy-Item $bakPath $Target -Force
    exit 1
}
& $node --check "$WorkDir\_installed_main.mjs"
if ($LASTEXITCODE -ne 0) {
    Write-Host '  ❌ 安装后自检失败：语法无效！正在回滚…' -ForegroundColor Red
    Copy-Item $bakPath $Target -Force
    exit 1
}
Write-Host '  ✅ 安装后结构自检通过'

$hasBootcheck = Select-String -Path "$WorkDir\_install_check.mjs" -Pattern 'DSH_PATCH_BOOTCHECK' -Quiet
if (-not $hasBootcheck) {
    Write-Host ''
    Write-Host '  ⚠️ 补丁未包含 BOOTCHECK（构建时 DSH_NO_BOOTCHECK=1 禁用）—— 跳过启动自检。' -ForegroundColor Yellow
    Write-Host '     ⟹ 请手动启动一次应用确认可用；或重建补丁时去掉该开关。'
} else {
# ---- ⑥ BOOTCHECK：真启动一次，验证 Electron 能加载补丁 asar ----
Write-Host ''
Write-Host '  BOOTCHECK：短暂启动一次应用自检（会闪一个窗口，属正常）…'
$bootFlag = Join-Path $WorkDir "_patch_boot_ok.flag"
Remove-Item $bootFlag -Force -ErrorAction SilentlyContinue
# ★ 清掉 ELECTRON_RUN_AS_NODE：若本脚本从 DSH 工具进程里跑会带着它，
#   Electron 会退化成纯 Node 模式永远起不来（P-282 排障实测的坑）
$saveRunAsNode = $env:ELECTRON_RUN_AS_NODE
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:DSH_PATCH_BOOTCHECK = $bootFlag
try {
    $bp = Start-Process -FilePath (Join-Path $Install "DeepSeek Harness.exe") -PassThru
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline -and -not (Test-Path $bootFlag) -and -not $bp.HasExited) {
        Start-Sleep -Milliseconds 500
    }
    if (-not $bp.HasExited) { try { & taskkill /PID $bp.Id /T /F 2>&1 | Out-Null } catch { } ; Start-Sleep -Seconds 2 }
    Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -eq (Join-Path $Install "DeepSeek Harness.exe") } |
        ForEach-Object { try { & taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null } catch { } }
} finally {
    Remove-Item Env:\DSH_PATCH_BOOTCHECK -ErrorAction SilentlyContinue
    if ($saveRunAsNode) { $env:ELECTRON_RUN_AS_NODE = $saveRunAsNode }
}
$bootLine = (Get-Content $bootFlag -ErrorAction SilentlyContinue | Select-Object -First 1)
if ($bootLine -match 'boot-ok') {
    Write-Host "  ✅ BOOTCHECK 通过：$($bootLine.Trim())"
    Remove-Item $bootFlag -Force -ErrorAction SilentlyContinue
} else {
    Write-Host '  ❌ BOOTCHECK 失败：补丁版应用未能启动！正在回滚…' -ForegroundColor Red
    Copy-Item $bakPath $Target -Force
    Remove-Item $bootFlag -Force -ErrorAction SilentlyContinue
    Write-Host '  ⟹ 已还原原版 app.asar。请把上面全部输出发回排查。'
    exit 1
}
}
Remove-Item "$WorkDir\_installed_main.mjs","$WorkDir\_install_check.mjs" -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '  =============================================================='
Write-Host '  ✅ 补丁已安装并通过启动自检' -ForegroundColor Green
Write-Host '  ⟹ 启动 DeepSeek Harness 即生效。'
Write-Host '  ⟹ 行为：渲染器崩溃（oom/crashed/killed）→ 250ms 后自动重载页面；'
Write-Host '    60s 内最多 2 次（隔久的孤立崩溃不占预算）；仍崩才弹诊断窗。'
Write-Host '  ⟹ 每次恢复都记录在 logs/renderer-recovery.log（可审计）。'
Write-Host '  ⟹ 还原：revert-asar.ps1'
Write-Host '  ⟹ 官方更新覆盖本补丁后：官方已修则无需再打；未修则重跑 patch-asar.mjs。'
Write-Host '  =============================================================='
