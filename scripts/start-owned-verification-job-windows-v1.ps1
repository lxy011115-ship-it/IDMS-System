param(
 [Parameter(Mandatory=$true)][string]$JobFile,
 [Parameter(Mandatory=$true)][string]$NodeExecutable
)
$ErrorActionPreference='Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'VERIFICATION_JOB_WINDOWS_REQUIRED' }
$jobItem=Get-Item -LiteralPath $JobFile
$nodeItem=Get-Item -LiteralPath $NodeExecutable
$supervisorItem=Get-Item -LiteralPath (Join-Path $PSScriptRoot 'owned-verification-job-v1.mjs')
$jobSpec=Get-Content -LiteralPath $jobItem.FullName -Raw -Encoding utf8 | ConvertFrom-Json
if ($jobSpec.format -ne 1 -or $jobSpec.purpose -ne 'IDMS_OWNED_VERIFICATION_JOB_V1' -or $jobSpec.jobId -notmatch '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$') { throw 'VERIFICATION_JOB_ENVELOPE' }
if ((Get-FileHash -LiteralPath $nodeItem.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $jobSpec.nodeSha256 -or (Get-FileHash -LiteralPath $supervisorItem.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $jobSpec.supervisorSha256) { throw 'VERIFICATION_JOB_SOURCE_CHANGED' }
foreach ($taskPath in @($nodeItem.FullName,$supervisorItem.FullName,$jobItem.FullName)) {
 if ($taskPath.Contains('"') -or $taskPath -match '[\x00-\x1f\x7f]') { throw 'VERIFICATION_JOB_COMMAND_PATH' }
}
$environmentPairs=@()
foreach ($environmentName in @('SystemRoot','WINDIR','COMSPEC','TEMP','TMP','PATH','USERDOMAIN','USERNAME','USERPROFILE','LOCALAPPDATA','APPDATA','ProgramFiles','ProgramData','HOMEDRIVE','HOMEPATH')) {
 $environmentValue=[Environment]::GetEnvironmentVariable($environmentName)
 if ($null -ne $environmentValue) { $environmentPairs+=($environmentName+'='+$environmentValue) }
}
# WMI creates an independent OS parent; no task, service or recurring automation is installed.
$startupInfo=New-CimInstance -ClassName Win32_ProcessStartup -Namespace 'root/cimv2' -ClientOnly -Property @{ShowWindow=[uint16]0;CreateFlags=[uint32]8;EnvironmentVariables=[string[]]$environmentPairs}
$commandLine='"'+$nodeItem.FullName+'" "'+$supervisorItem.FullName+'" --supervise "'+$jobItem.FullName+'"'
$createdJob=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$commandLine;CurrentDirectory=[string]$jobSpec.workingDirectory;ProcessStartupInformation=$startupInfo}
if ($createdJob.ReturnValue -ne 0 -or $createdJob.ProcessId -le 0) { throw 'VERIFICATION_JOB_OS_CREATE_FAILED' }
$receipt=[ordered]@{format='IDMS_VERIFICATION_JOB_OS_LAUNCH_V1';jobId=$jobSpec.jobId;inputSha256=(Get-FileHash -LiteralPath $jobItem.FullName -Algorithm SHA256).Hash.ToLowerInvariant();supervisorPid=[int]$createdJob.ProcessId;win32ReturnValue=[int]$createdJob.ReturnValue;hidden=$true;independentOsParent=$true;genericKillUsed=$false;at=[DateTimeOffset]::Now.ToString('o')}
$receiptPath=Join-Path $jobItem.DirectoryName 'os-launch.private.json'
$receiptBytes=[Text.UTF8Encoding]::new($false).GetBytes(($receipt | ConvertTo-Json -Compress))
$receiptStream=[IO.FileStream]::new($receiptPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try { $receiptStream.Write($receiptBytes,0,$receiptBytes.Length);$receiptStream.Flush($true) } finally { $receiptStream.Dispose() }
$receipt | ConvertTo-Json -Compress
