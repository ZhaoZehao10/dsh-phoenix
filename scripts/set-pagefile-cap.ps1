# ★ P-278 善后：把页面文件从「自动管理」改为固定 24 GB。
#
# 为什么：崩溃现场 Windows 已把系统管理的页面文件撑到约 96 GiB
#   （SystemCommitLimit 127.87 GiB − 物理 31.87 GiB），机器在彻底死掉前
#   经历了长时间的换页卡顿。固定上限 ⟹ 超限时立刻干净失败，而不是先卡十分钟。
#
# 24 GB 的由来：本机峰值工作负载约 24 GB（门禁 + 泄漏的 embedding 服务），
#   物理 32 GB + 页面文件 24 GB = 约 56 GB 提交上限，对这个负载足够。
#   C: 盘当前剩余 672 GB，空间不是约束。
#
# 必须以【管理员身份】运行。改完必须重启才生效。
# 想改回自动管理：见文件末尾 Revert 段。

#requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'

$InitialMB = 24576
$MaximumMB = 24576
$Drive = 'C:'
$PageFile = "$Drive\pagefile.sys"

Write-Host ''
Write-Host '  当前状态' -ForegroundColor Cyan
$cs = Get-CimInstance Win32_ComputerSystem
Write-Host ("    AutomaticManagedPagefile = {0}" -f $cs.AutomaticManagedPagefile)
Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host ("    {0}  allocated={1} MB  peak={2} MB" -f $_.Name, $_.AllocatedBaseSize, $_.PeakUsage) }
$setting = Get-CimInstance Win32_PageFileSetting -ErrorAction SilentlyContinue
if ($setting) {
    Write-Host ("    Win32_PageFileSetting: {0}  {1}..{2} MB" -f $setting.Name, $setting.InitialSize, $setting.MaximumSize)
} else {
    Write-Host '    Win32_PageFileSetting: （无实例，当前由系统自动管理）'
}

Write-Host ''
Write-Host ("  将设置为：{0}  固定 {1} MB ({2} GB)" -f $PageFile, $InitialMB, [math]::Round($InitialMB/1024,1)) -ForegroundColor Yellow
Write-Host '  ⟹ 提交上限将约为 56 GB（物理 31.87 GiB + 页面文件 24 GB）'
Write-Host ''

# ---- ① 关闭自动管理 ----
if ($cs.AutomaticManagedPagefile) {
    $cs | Set-CimInstance -Property @{ AutomaticManagedPagefile = $false }
    Write-Host '  ✅ 已关闭 AutomaticManagedPagefile'
} else {
    Write-Host '  ℹ️ AutomaticManagedPagefile 已经是 false'
}

# ---- ② 设置固定大小的页面文件 ----
# Set-WmiInstance 在实例不存在时会创建它。
try {
    Set-WmiInstance -Class Win32_PageFileSetting -Arguments @{
        Name        = $PageFile
        InitialSize = $InitialMB
        MaximumSize = $MaximumMB
    } -ErrorAction Stop | Out-Null
    Write-Host ("  ✅ 已设置 {0} = {1}..{2} MB" -f $PageFile, $InitialMB, $MaximumMB)
} catch {
    # 已存在同名实例时走更新分支
    Write-Host ("  ℹ️ 实例可能已存在，改用更新：{0}" -f $_.Exception.Message)
    Set-CimInstance -ClassName Win32_PageFileSetting `
        -Query "Name='$PageFile'" `
        -Property @{ InitialSize = $InitialMB; MaximumSize = $MaximumMB }
    Write-Host ("  ✅ 已更新 {0} = {1}..{2} MB" -f $PageFile, $InitialMB, $MaximumMB)
}

Write-Host ''
Write-Host '  验证（重启前看到的是旧值，重启后才生效）' -ForegroundColor Cyan
$after = Get-CimInstance Win32_PageFileSetting -ErrorAction SilentlyContinue
if ($after) {
    Write-Host ("    {0}  {1}..{2} MB" -f $after.Name, $after.InitialSize, $after.MaximumSize)
} else {
    Write-Host '    ⚠️ 仍无 Win32_PageFileSetting 实例 —— 请检查上面的错误'
}

$os = Get-CimInstance Win32_OperatingSystem
Write-Host ("    当前提交上限 = {0} GB（重启后应变为约 56 GB）" -f `
    [math]::Round(($os.TotalVirtualMemorySize + $os.FreeVirtualMemory) / 1024 / 1024, 1))

Write-Host ''
Write-Host '  ⟹ 请重启使之生效。' -ForegroundColor Green
Write-Host ''
Write-Host '  ---- Revert（想改回自动管理）----'
Write-Host '    $cs = Get-CimInstance Win32_ComputerSystem'
Write-Host '    $cs | Set-CimInstance -Property @{ AutomaticManagedPagefile = $true }'
Write-Host '    Get-CimInstance Win32_PageFileSetting | Remove-CimInstance'
Write-Host '    # 然后重启'

<#
 ==============================================================================
 Revert（想改回自动管理）—— 管理员 PowerShell 里跑：

   $cs = Get-CimInstance Win32_ComputerSystem
   $cs | Set-CimInstance -Property @{ AutomaticManagedPagefile = $true }
   Get-CimInstance Win32_PageFileSetting | Remove-CimInstance
   Restart-Computer

 只想去掉固定值但仍保留手动控制：把 InitialSize/MaximumSize 调大即可，
 不必切回自动管理。
 ==============================================================================
#>
