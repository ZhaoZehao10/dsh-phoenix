# ★ P-278 善后：DSH 会话体积守护。
#
# 为什么：崩溃缺陷的直接推手是「单个会话被无限复用」——resident event window
# 随日志增长且不收缩。交接材料的判据是「压缩后 > 10 MB 就收尾换新会话」。
# 本机崩溃会话 6.94 MB，是第二名的 7 倍（指纹在，绝对体积还没到线）。
#
# 这个脚本把「定期检查」变成一条命令：
#   · 列出所有会话的体积 / 最后修改时间 / 是否仍在增长
#   · 超过阈值就明确警告，并给出「怎么收尾」的具体步骤
#   · 附带渲染进程当前内存，方便和体积对照
#
# 零依赖。用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\check-dsh-sessions.ps1
#   ... -ThresholdMB 10                 # 自定义阈值
#   ... -Watch 300                      # 每 300 秒重复一次（Ctrl+C 退出）
#   ... -ShowRaw                        # 解压最大那个会话，报真实原始体积
#
# 退出码：0 = 全部低于阈值；1 = 有会话超阈值（可用于计划任务/CI）

[CmdletBinding()]
param(
    [double]$ThresholdMB = 10,
    [int]$Watch = 0,
    [switch]$ShowRaw
)

$ErrorActionPreference = 'Stop'
$SessionsRoot = Join-Path $env:USERPROFILE '.dsh\sessions'
$NodeExe = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'

function Get-SessionInfo {
    if (-not (Test-Path $SessionsRoot)) { return @() }
    $rows = @()
    foreach ($ws in Get-ChildItem $SessionsRoot -Directory) {
        foreach ($s in Get-ChildItem $ws.FullName -Directory) {
            foreach ($f in Get-ChildItem $s.FullName -File -Filter '*.zstd') {
                $rows += [pscustomobject]@{
                    Workspace = ($ws.Name -replace '^--' -replace '--$')
                    Session   = $s.Name
                    Path      = $f.FullName
                    MB        = [math]::Round($f.Length / 1MB, 3)
                    Modified  = $f.LastWriteTime
                }
            }
        }
    }
    return $rows | Sort-Object MB -Descending
}

function Get-RendererMemoryMB {
    try {
        $p = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
             Where-Object { $_.CommandLine -like '*--type=renderer*' } |
             Select-Object -First 1
        if ($p) {
            $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
            if ($proc) { return [math]::Round($proc.PagedMemorySize64 / 1MB, 0) }
        }
    } catch { }
    return $null
}

function Get-RawBytes([string]$zstPath) {
    # 用 DSH 自带的 Node 解压（zlib.zstdDecompressSync，Node 22.15+ 可用）
    if (-not (Test-Path $NodeExe)) { return $null }
    $js = @"
const fs=require('fs'),zlib=require('zlib');
// 注意：argv[1] 是脚本自身，argv[2] 才是传入的 .zstd 路径
const b=fs.readFileSync(process.argv[2]);
const offs=[];for(let i=0;i+4<=b.length;i++){if(b[i]===0x28&&b[i+1]===0xB5&&b[i+2]===0x2F&&b[i+3]===0xFD)offs.push(i);}
const chunks=[];for(let k=0;k<offs.length;k++){const s=offs[k],e=k+1<offs.length?offs[k+1]:b.length;try{chunks.push(zlib.zstdDecompressSync(b.slice(s,e)));}catch(e){}}
process.stdout.write(String(Buffer.concat(chunks).length));
"@
    $tmp = [IO.Path]::GetTempFileName() + '.cjs'
    # 必须带 BOM，否则 PS 5.1 按 GBK 写出去会让 Node 解析失败
    [IO.File]::WriteAllText($tmp, $js, (New-Object Text.UTF8Encoding($false)))
    try {
        $out = & $NodeExe $tmp $zstPath 2>$null
        if ($out -match '^\d+$') { return [int64]$out }
    } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
    return $null
}

function Format-Age([TimeSpan]$age) {
    # 注意：PowerShell 不支持 `$var = if (...) {} elseif (...) {}` 这种表达式形式，
    # 必须用语句形式 + 早返回（否则报「< 运算符保留供将来使用」）。
    if ($age.TotalMinutes -lt 1) { return '刚刚' }
    if ($age.TotalHours -lt 1) { return ('{0} 分钟前' -f [int]$age.TotalMinutes) }
    if ($age.TotalDays -lt 1) { return ('{0} 小时前' -f [int]$age.TotalHours) }
    return ('{0} 天前' -f [int]$age.TotalDays)
}

function Show-Report {
    $sessions = Get-SessionInfo
    $renMB = Get-RendererMemoryMB

    Write-Host ''
    Write-Host ('  ' + ('=' * 74))
    Write-Host '  DSH 会话体积守护'
    Write-Host ('  阈值 ' + $ThresholdMB + ' MB 压缩 ｜ ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    Write-Host ('  ' + ('=' * 74))

    if (-not $sessions -or $sessions.Count -eq 0) {
        Write-Host '  （没有找到任何会话）' -ForegroundColor DarkGray
        return 0
    }

    # 表头
    Write-Host ('  {0,-9} {1,-12} {2,-40} {3}' -f 'MB', '最后修改', '会话', '工作区')
    Write-Host ('  ' + ('-' * 74))

    $over = @()
    $second = $null
    if ($sessions.Count -ge 2) { $second = $sessions[1].MB }

    foreach ($s in $sessions) {
        $age = (Get-Date) - $s.Modified
        $ageTxt = Format-Age $age
        $flag = ''
        $color = 'Gray'
        if ($s.MB -ge $ThresholdMB) {
            $flag = '  ⟵ 超阈值'
            $color = 'Red'
            $over += $s
        } elseif ($second -gt 0 -and $s.MB -ge 5 * $second) {
            $flag = '  ⟵ 是第二名的 5 倍以上（单会话复用指纹）'
            $color = 'Yellow'
        }
        Write-Host ('  {0,-9} {1,-12} {2,-40} {3}{4}' -f `
            $s.MB, $ageTxt, $s.Session.Substring(0, [Math]::Min(38, $s.Session.Length)), $s.Workspace, $flag) `
            -ForegroundColor $color
    }

    Write-Host ''
    Write-Host ('  会话数 ' + $sessions.Count + ' ｜ 合计 ' + `
        ([math]::Round(($sessions | Measure-Object MB -Sum).Sum, 2)) + ' MB')

    if ($renMB -ne $null) {
        Write-Host ('  渲染进程当前提交量  ' + $renMB + ' MB')
    }

    # 最大会话的真实原始体积
    if ($ShowRaw -and $sessions.Count -gt 0) {
        $raw = Get-RawBytes $sessions[0].Path
        if ($raw) {
            Write-Host ('  最大会话原始体积    ' + [math]::Round($raw / 1MB, 1) + ' MB' +
                        '  （压缩比 ' + [math]::Round($raw / 1MB / $sessions[0].MB, 1) + 'x）')
        }
    }

    if ($over.Count -gt 0) {
        Write-Host ''
        Write-Host ('  ⚠️  ' + $over.Count + ' 个会话超过 ' + $ThresholdMB + ' MB') -ForegroundColor Red
        Write-Host '     ⟹ 收尾它，开新会话交接工作（会话数据持久化，不会丢）'
        Write-Host '     ⟹ 别在这个会话里反复向上翻历史 —— 每次 loadOlder() 都把更多历史页'
        Write-Host '        固化进内存且永不释放，这是内存增长的直接推手'
        return 1
    }

    Write-Host ''
    Write-Host '  ✅ 全部低于阈值' -ForegroundColor Green
    return 0
}

# ---- 主 ----
do {
    $rc = Show-Report
    if ($Watch -gt 0) {
        Write-Host ''
        Write-Host ("  （每 $Watch 秒重复，Ctrl+C 退出）") -ForegroundColor DarkGray
        Start-Sleep -Seconds $Watch
    }
} while ($Watch -gt 0)

exit $rc
