# ★ P-282：还原 app.asar 到打补丁前的原版。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File .\revert-asar.ps1
$ErrorActionPreference = 'Stop'
$Install = if ($env:DSH_INSTALL_DIR) { $env:DSH_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\DeepSeek Harness" }
$Target  = Join-Path $Install "resources\app.asar"

# 同 install-patched：只算真实安装的进程；镜像已删的僵尸不算（不持有 app.asar）
$exePath = Join-Path $Install "DeepSeek Harness.exe"
$all = Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue
$blockers = @($all | Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).ExecutablePath -eq $exePath })
if ($blockers.Count -gt 0) {
    Write-Host '  ❌ DeepSeek Harness 正在运行，先退出再还原。' -ForegroundColor Red
    Write-Host "     （正在运行: $(($blockers | ForEach-Object { $_.Id }) -join ', ')）"
    exit 1
}
$backup = Get-ChildItem (Join-Path $Install "resources") -Filter "app.asar.bak-*" -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $backup) {
    Write-Host '  ❌ 找不到备份（app.asar.bak-*）。' -ForegroundColor Red
    exit 1
}
Copy-Item $backup.FullName $Target -Force
Write-Host ("  ✅ 已还原 {0} → {1}" -f $backup.Name, $Target)
Write-Host '  ⟹ 启动 DeepSeek Harness 即回到官方原版。'
