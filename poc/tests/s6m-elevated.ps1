# S6m 승격 측정(수동 실행, 관리자 승인 1회).
# (1) manage-bde·Get-BitLockerVolume으로 C: 상태를 읽어 비승격 Shell 속성 값과 대조한다. 복구 키(KeyProtector)는 읽지 않는다.
# (2) 64MB VHDX를 만들어 NTFS로 포맷하고 루트 기본 ACL(SDDL)을 남긴다. 비승격 쪽 확인이 끝났다는 표시 파일(done)을 기다렸다가 분리·삭제한다.
# 실행(비승격 셸에서): Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File <이 파일> -OutDir <폴더>'
param([Parameter(Mandatory = $true)][string]$OutDir, [int]$WaitSeconds = 600)
$ErrorActionPreference = 'Stop'
$sys = Join-Path $env:SystemRoot 'System32'
$vhd = Join-Path $OutDir 's6m-secondary.vhdx'
$done = Join-Path $OutDir 'done'
$status = [ordered]@{ at = (Get-Date).ToString('o') }
$mounted = $false
try {
  $status.manageBde = (& "$sys\manage-bde.exe" -status C:) -join "`n"
  $status.bitLockerVolume = Get-BitLockerVolume -MountPoint 'C:' | Select-Object MountPoint, VolumeType, VolumeStatus, ProtectionStatus, LockStatus, EncryptionPercentage, EncryptionMethod

  if (Test-Path $vhd) { throw "vhdx already exists: $vhd" }
  $dp = Join-Path $OutDir 'create-vdisk.txt'
  Set-Content -Path $dp -Encoding ascii -Value "create vdisk file=`"$vhd`" maximum=64 type=expandable"
  & "$sys\diskpart.exe" /s $dp | Out-Null
  if (-not (Test-Path $vhd)) { throw 'diskpart did not create the vhdx' }
  Mount-DiskImage -ImagePath $vhd | Out-Null
  $mounted = $true
  # 디스크 번호를 짐작하지 않는다. 이 VHDX에 붙은 디스크 하나이고, 64MB 근처이고, 초기화 전(RAW)일 때만 진행한다.
  $disk = @(Get-DiskImage -ImagePath $vhd | Get-Disk)
  if ($disk.Count -ne 1 -or $disk[0].Size -gt 100MB -or $disk[0].PartitionStyle -ne 'RAW') { throw 'unexpected disk for the vhdx' }
  $n = $disk[0].Number
  Initialize-Disk -Number $n -PartitionStyle GPT
  $part = New-Partition -DiskNumber $n -UseMaximumSize -AssignDriveLetter
  Format-Volume -Partition $part -FileSystem NTFS -NewFileSystemLabel 'S6M' -Confirm:$false | Out-Null
  $root = "$($part.DriveLetter):\"
  $aclFile = Join-Path $OutDir 'acl-root.txt'
  & "$sys\icacls.exe" $root /save $aclFile | Out-Null
  $status.root = $root
  $status.rootSddl = ((Get-Content -Path $aclFile -Encoding Unicode) | Where-Object { $_ -like 'D:*' }) -join ''
  $status.rootIcacls = (& "$sys\icacls.exe" $root) -join "`n"
} catch {
  $status.error = $_.Exception.Message
} finally {
  $status | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $OutDir 's6m-elevated.json') -Encoding utf8
  if ($mounted) {
    if (-not $status.error) {
      $deadline = (Get-Date).AddSeconds($WaitSeconds)
      while (-not (Test-Path $done) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    }
    Dismount-DiskImage -ImagePath $vhd | Out-Null
  }
  if (Test-Path $vhd) { Remove-Item -Path $vhd -Force }
}
