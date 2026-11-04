# ★ P-278 善后：收尾（归档）超大的 DSH 会话。
#
# 为什么：崩溃缺陷的直接推手是「单个会话被无限复用」。收尾它、开新会话，
# 数据不会丢（会话是持久化的），只是重新开始累积。
#
# 安全设计：
#   ① 默认拒绝归档**仍在写入**的会话（连续采样，字节数在涨就不动）；
#   ② 只移动，不删除 —— 归档到 ~/.dsh/sessions-archive/<时间戳>/，可完整还原；
#   ③ 打印还原命令。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\retire-dsh-session.ps1 -List
#   ... -Session session-031786ea-86b4-4862-9218-c70c2a057199
#   ... -Largest                 # 归档最大的那个（默认行为）
#   ... -Force                   # 跳过「仍在写入」检查（不推荐）
#   ... -WhatIf                  # 只演示，不真动

[CmdletBinding(SupportsShouldProcess=$true)]
param(
    [string]$Session,
    [switch]$Largest,
    [switch]$Force,
    [switch]$List
)

$ErrorActionPreference = 'Stop'
$SessionsRoot = Join-Path $env:USERPROFILE '.dsh\sessions'
$ArchiveRoot  = Join-Path $env:USERPROFILE '.dsh\sessions-archive'

function Get-Sessions {
    $rows = @()
    foreach ($ws in Get-ChildItem $SessionsRoot -Directory) {
        foreach ($s in Get-ChildItem $ws.FullName -Directory) {
            $f = Get-ChildItem $s.FullName -File -Filter '*.zstd' -ErrorAction SilentlyContinue |
                 Select-Object -First 1
            if ($f) {
                $rows += [pscustomobject]@{
                    Id        = $s.Name
                    Workspace = $ws.Name
                    Dir       = $s.FullName
                    File      = $f.FullName
                    MB        = [math]::Round($f.Length / 1MB, 3)
                }
            }
        }
    }
    return $rows | Sort-Object MB -Descending
}

if ($List) {
    Write-Host ''
    Write-Host '  会话清单（按体积降序）'
    Write-Host ('  ' + ('-' * 70))
    foreach ($s in (Get-Sessions)) {
        Write-Host ('  {0,-9} {1,-46} {2}' -f $s.MB, $s.Id, ($s.Workspace -replace '^--' -replace '--$'))
    }
    Write-Host ''
    exit 0
}

$sessions = Get-Sessions
if (-not $sessions -or $sessions.Count -eq 0) {
    Write-Host '  （没有会话）'
    exit 0
}

# ---- 选目标 ----
$target = $null
if ($Session) {
    $target = $sessions | Where-Object { $_.Id -like "$Session*" } | Select-Object -First 1
    if (-not $target) { Write-Host "  ❌ 找不到会话：$Session" -ForegroundColor Red; exit 1 }
} else {
    $target = $sessions[0]
    Write-Host ("  未指定 -Session，取最大的那个：{0} MB" -f $target.MB)
}

Write-Host ''
Write-Host '  目标会话' -ForegroundColor Cyan
Write-Host ("    ID        {0}" -f $target.Id)
Write-Host ("    工作区    {0}" -f ($target.Workspace -replace '^--' -replace '--$'))
Write-Host ("    体积      {0} MB（压缩）" -f $target.MB)
Write-Host ("    目录      {0}" -f $target.Dir)

# ---- 安全检查：是否仍在写入 ----
Write-Host ''
Write-Host '  安全检查：采样 15 秒确认没有正在写入…'
$a = (Get-Item $target.File).Length
Start-Sleep -Seconds 15
$b = (Get-Item $target.File).Length
if ($b -gt $a) {
    Write-Host ("  ❌ 该会话仍在被写入（15 秒内 +{0} KB）" -f [math]::Round(($b - $a) / 1KB, 1)) -ForegroundColor Red
    Write-Host '     ⟹ 说明还有窗口/任务在用这个会话。先在那里面「开新会话」收尾，'
    Write-Host '       等工作告一段落再来归档。'
    if (-not $Force) {
        Write-Host '     ⟹ 坚持要归档就加 -Force（可能导致对方写入失败）' -ForegroundColor Yellow
        exit 1
    }
    Write-Host '     ⚠️ 已指定 -Force，继续' -ForegroundColor Yellow
} else {
    Write-Host '  ✅ 15 秒内无写入'
}

# ---- 归档（只移动，不删除）----
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest = Join-Path $ArchiveRoot ($stamp + '\' + $target.Id)
if ($PSCmdlet.ShouldProcess($target.Dir, "归档到 $dest")) {
    New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
    Move-Item -Path $target.Dir -Destination $dest
}

Write-Host ''
Write-Host '  ✅ 已归档' -ForegroundColor Green
Write-Host ("    新位置  {0}" -f $dest)
Write-Host ''
Write-Host '  后续动作：'
Write-Host '    1. 在 DSH 里对该工作区「开新会话」继续工作'
Write-Host '    2. 以后定期跑 check-dsh-sessions.ps1，超过 10 MB 就再收尾一次'
Write-Host ''
Write-Host '  还原方法（要恢复这个会话就跑）：'
Write-Host ("    Move-Item '{0}' '{1}'" -f $dest, (Join-Path $SessionsRoot $target.Workspace))
Write-Host ''
