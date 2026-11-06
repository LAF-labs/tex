# Windows 실기기 점검 5번(WIN-REALDEVICE): 설치된 앱의 기동 시간과 최대 메모리를 밖에서 잰다(앱에는 기동 시간 기록·측정 스위치가 없다).
# 표지: 프로세스 시작 → 창 핸들 → vault.log vault.started → engine.log engine.db_opened → 첫 화면 버튼(UI Automation, 약관 화면 '동의하고 시작').
#   로그 표지는 로그 줄의 at(UTC)과 프로세스 StartTime의 차이라 폴링 간격과 무관하다. 창·버튼은 폴링(250 ms) 시각이다.
# 메모리: 실행 파일 이름이 같은 프로세스 전체(Electron 메인·렌더러·GPU·utilityProcess 금고·엔진)의 작업 집합·전용 바이트 합을 250 ms마다 잰 최대값.
# 첫 화면이 뜨면 SettleSec 동안 더 잰 뒤 s6e-capture.ps1로 앱 창만 찍고(-ShotPrefix), 창을 닫는다.
# 실행: powershell -NoProfile -File tests/win-realdevice-launch.ps1 -Exe "$env:LOCALAPPDATA\Programs\sovereign-ax\SovereignAX.exe" -OutJson out.json [-ShotPrefix shots/first]
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$OutJson,
  [string]$ShotPrefix = '',
  [int]$TimeoutSec = 240,
  [int]$SettleSec = 15,
  # 직접 띄우지 않고 이 이름의 프로세스가 뜨기를 기다렸다가 붙는다(설치 마법사의 runAfterFinish 첫 실행을 잴 때). 기다리는 상한(초).
  [int]$AttachWaitSec = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = Join-Path $env:LOCALAPPDATA 'SovereignAX'
$firstRun = -not (Test-Path (Join-Path $root 'db\db.sqlite'))
# '동의하고 시작'(파일 인코딩과 무관하게 코드 포인트로 만든다)
$agree = -join [char[]](0xB3D9, 0xC758, 0xD558, 0xACE0, 0x20, 0xC2DC, 0xC791)
$name = [IO.Path]::GetFileNameWithoutExtension($Exe)
if (@(Get-Process -Name $name -ErrorAction SilentlyContinue).Count -gt 0) { throw "$name is already running; close it first." }

function LogAtMs([string]$file, [string]$code, [datetime]$start) {
  $p = Join-Path $root "logs\$file"
  if (-not (Test-Path -LiteralPath $p)) { return $null }
  try { $lines = Get-Content -LiteralPath $p -ErrorAction Stop } catch { return $null }
  # 로그는 실행마다 이어 쓴다. 이 프로세스 시작 뒤의 첫 줄만 본다.
  foreach ($l in $lines) {
    if ($l -notlike "*`"code`":`"$code`"*") { continue }
    $at = [datetime]::Parse(($l | ConvertFrom-Json).at, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal)
    $ms = [int]($at - $start.ToUniversalTime()).TotalMilliseconds
    if ($ms -ge 0) { return $ms }
  }
  return $null
}
function TreeMem {
  $ps = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
  [pscustomobject]@{ n = $ps.Count; ws = [long]($ps | Measure-Object WorkingSet64 -Sum).Sum; priv = [long]($ps | Measure-Object PrivateMemorySize64 -Sum).Sum }
}
function UiReady($proc) {
  $proc.Refresh()
  if ($proc.MainWindowHandle -eq [IntPtr]::Zero) { return $false }
  try {
    $w = [Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
    $c = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, $agree)
    return $null -ne $w.FindFirst([Windows.Automation.TreeScope]::Descendants, $c)
  } catch { return $false }
}

if ($AttachWaitSec -gt 0) {
  # 가장 먼저 뜬 같은 이름 프로세스가 Electron 메인이다. 시각은 그 프로세스의 StartTime부터 잰다.
  $until = (Get-Date).AddSeconds($AttachWaitSec)
  $p = $null
  while ((Get-Date) -lt $until -and $null -eq $p) {
    $p = Get-Process -Name $name -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1
    if ($null -eq $p) { Start-Sleep -Milliseconds 100 }
  }
  if ($null -eq $p) { throw "$name did not start within $AttachWaitSec s" }
  $start = $p.StartTime
  $attachLagMs = [int]((Get-Date) - $start).TotalMilliseconds
} else {
  $p = Start-Process -FilePath $Exe -PassThru
  $start = $p.StartTime
  $attachLagMs = 0
}
# 모든 표지는 메인 프로세스 StartTime 기준 ms다. 스톱워치는 상한·안정 대기에만 쓴다.
$sw = [Diagnostics.Stopwatch]::StartNew()
function SinceStart { [int]((Get-Date) - $start).TotalMilliseconds }
$mark = [ordered]@{ windowHandleMs = $null; vaultStartedMs = $null; dbOpenedMs = $null; uiReadyMs = $null }
$peak = [ordered]@{ wsMb = 0; privMb = 0; procs = 0 }
$timeline = New-Object System.Collections.Generic.List[object]
$readyAt = $null
$lastUi = -1000
while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec -and -not $p.HasExited) {
  $m = TreeMem
  $peak.wsMb = [Math]::Max($peak.wsMb, [Math]::Round($m.ws / 1MB, 1))
  $peak.privMb = [Math]::Max($peak.privMb, [Math]::Round($m.priv / 1MB, 1))
  $peak.procs = [Math]::Max($peak.procs, $m.n)
  $now = SinceStart
  if ($timeline.Count -eq 0 -or $now - $timeline[$timeline.Count - 1].ms -ge 1000) { $timeline.Add([pscustomobject]@{ ms = $now; procs = $m.n; wsMb = [Math]::Round($m.ws / 1MB, 1) }) }
  if ($null -eq $mark.windowHandleMs) { $p.Refresh(); if ($p.MainWindowHandle -ne [IntPtr]::Zero) { $mark.windowHandleMs = $now } }
  if ($null -eq $mark.vaultStartedMs) { $mark.vaultStartedMs = LogAtMs 'vault.log' 'vault.started' $start }
  if ($null -eq $mark.dbOpenedMs) { $mark.dbOpenedMs = LogAtMs 'engine.log' 'engine.db_opened' $start }
  # UI Automation 조회는 이 PC에서 수백 ms라 1초마다만 본다.
  if ($null -eq $mark.uiReadyMs -and $null -ne $mark.windowHandleMs -and $now - $lastUi -ge 1000) {
    $lastUi = $now
    if (UiReady $p) { $mark.uiReadyMs = SinceStart; $readyAt = $sw.Elapsed.TotalSeconds }
  }
  if ($null -ne $readyAt -and $sw.Elapsed.TotalSeconds -ge $readyAt + $SettleSec) { break }
  Start-Sleep -Milliseconds 250
}
$shots = $null
if ($ShotPrefix -and -not $p.HasExited) {
  New-Item -ItemType Directory -Force (Split-Path -Parent $ShotPrefix) | Out-Null
  $shots = & (Join-Path $PSScriptRoot 's6e-capture.ps1') -ProcessId $p.Id -OutPrefix $ShotPrefix | ConvertFrom-Json
}
$exitedBySelf = $p.HasExited
if (-not $p.HasExited) {
  $null = $p.CloseMainWindow()
  if (-not $p.WaitForExit(30000)) { Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force }
}
Start-Sleep -Seconds 2
$exePath = $(try { $p.Path } catch { $null })
if (-not $exePath) { $exePath = $Exe }
$ver = $(try { (Get-Item -LiteralPath $exePath).VersionInfo } catch { $null })
$out = [ordered]@{
  exeVersion = $(if ($ver) { $ver.ProductVersion } else { $null })
  installDirLeaf = $(if ($exePath) { Split-Path -Leaf (Split-Path -Parent $exePath) } else { $null })
  firstRun = $firstRun
  attached = $AttachWaitSec -gt 0
  attachLagMs = $attachLagMs
  marks = $mark
  peak = $peak
  exitedBySelf = $exitedBySelf
  exitCode = $(if ($p.HasExited) { $p.ExitCode } else { $null })
  leftoverProcs = @(Get-Process -Name $name -ErrorAction SilentlyContinue).Count
  timeline = $timeline
  shots = $shots
}
New-Item -ItemType Directory -Force (Split-Path -Parent $OutJson) | Out-Null
$out | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $OutJson
$out | ConvertTo-Json -Depth 5
