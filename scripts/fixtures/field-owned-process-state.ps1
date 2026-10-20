param([Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$ProcessId,[Parameter(Mandatory=$true)][ValidatePattern('^\d{17,20}$')][string]$StartTicks)
$ErrorActionPreference='Stop'
try {$ownedProcess=[Diagnostics.Process]::GetProcessById($ProcessId)} catch [ArgumentException] {[Console]::Out.Write('TERMINAL');exit 0}
try {
 if($ownedProcess.HasExited -or $ownedProcess.StartTime.ToUniversalTime().Ticks.ToString() -cne $StartTicks){[Console]::Out.Write('TERMINAL')}else{[Console]::Out.Write('MATCHING_LIVE')}
} finally {$ownedProcess.Dispose()}
