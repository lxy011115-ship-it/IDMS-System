param([Parameter(Mandatory=$true)][int]$TargetProcess,[Parameter(Mandatory=$true)][string]$ExpectedCreatedAt)
$ErrorActionPreference='Stop'
$observed=Get-CimInstance Win32_Process -Filter "ProcessId=$TargetProcess"
if(-not $observed){throw 'Capacity target process is absent'}
if($observed.CreationDate.ToUniversalTime().Ticks -ne ([DateTimeOffset]::Parse($ExpectedCreatedAt)).UtcTicks){throw 'Capacity target process identity changed'}
@{pid=[int]$observed.ProcessId;createdAt=$observed.CreationDate.ToString('o');cpuSeconds=([double]$observed.KernelModeTime+[double]$observed.UserModeTime)/10000000;workingSetBytes=[double]$observed.WorkingSetSize;privatePageBytes=[double]$observed.PrivatePageCount}|ConvertTo-Json -Compress
