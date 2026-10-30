param(
 [Parameter(Mandatory=$true)][string]$JobFile,
 [Parameter(Mandatory=$true)][string]$NodeExecutable
)
$ErrorActionPreference='Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'VERIFICATION_JOB_WINDOWS_REQUIRED' }
$jobItem=Get-Item -LiteralPath $JobFile
$nodeItem=Get-Item -LiteralPath $NodeExecutable
$supervisorItem=Get-Item -LiteralPath (Join-Path $PSScriptRoot 'owned-verification-job-v1.mjs')
$sourceItem=Get-Item -LiteralPath (Join-Path $PSScriptRoot 'owned-verification-restricted-host-v2.cs')
$jobSpec=Get-Content -LiteralPath $jobItem.FullName -Raw -Encoding utf8 | ConvertFrom-Json
if ($jobSpec.format -ne 1 -or $jobSpec.purpose -ne 'IDMS_OWNED_VERIFICATION_JOB_V1' -or $jobSpec.jobId -notmatch '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$') { throw 'VERIFICATION_JOB_ENVELOPE' }
if ((Get-FileHash -LiteralPath $nodeItem.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $jobSpec.nodeSha256 -or (Get-FileHash -LiteralPath $supervisorItem.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $jobSpec.supervisorSha256) { throw 'VERIFICATION_JOB_SOURCE_CHANGED' }
$hostFile=Join-Path $jobItem.DirectoryName 'restricted-host.exe'
if (Test-Path -LiteralPath $hostFile) { throw 'VERIFICATION_JOB_RESTRICTED_HOST_ALREADY_EXISTS' }
$compiler=[Microsoft.CSharp.CSharpCodeProvider]::new()
$parameters=[CodeDom.Compiler.CompilerParameters]::new()
$parameters.GenerateExecutable=$true
$parameters.GenerateInMemory=$false
$parameters.OutputAssembly=$hostFile
$parameters.CompilerOptions='/target:winexe /optimize+'
foreach ($assembly in @('System.dll','System.Core.dll','System.Runtime.Serialization.dll','System.Xml.dll')) { [void]$parameters.ReferencedAssemblies.Add($assembly) }
try { $compiled=$compiler.CompileAssemblyFromFile($parameters,$sourceItem.FullName) } finally { $compiler.Dispose() }
if ($compiled.Errors.HasErrors) { $compiled.Errors | ForEach-Object { [pscustomobject]@{code=$_.ErrorNumber;line=$_.Line;column=$_.Column} } | ConvertTo-Json -Compress; throw 'VERIFICATION_JOB_RESTRICTED_HOST_COMPILE_FAILED' }
$request=[ordered]@{format='IDMS_RESTRICTED_SUPERVISOR_REQUEST_V1';jobId=$jobSpec.jobId;jobFile=$jobItem.FullName;jobSha256=(Get-FileHash -LiteralPath $jobItem.FullName -Algorithm SHA256).Hash.ToLowerInvariant();nodeFile=$nodeItem.FullName;nodeSha256=$jobSpec.nodeSha256;supervisorFile=$supervisorItem.FullName;supervisorSha256=$jobSpec.supervisorSha256;workingDirectory=$jobSpec.workingDirectory;hostSha256=(Get-FileHash -LiteralPath $hostFile -Algorithm SHA256).Hash.ToLowerInvariant()}
$requestFile=Join-Path $jobItem.DirectoryName 'restricted-launch.private.json'
$requestBytes=[Text.UTF8Encoding]::new($false).GetBytes(($request | ConvertTo-Json -Compress))
$stream=[IO.FileStream]::new($requestFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try { $stream.Write($requestBytes,0,$requestBytes.Length);$stream.Flush($true) } finally { $stream.Dispose() }
$requestSha=(Get-FileHash -LiteralPath $requestFile -Algorithm SHA256).Hash.ToLowerInvariant()
foreach ($taskPath in @($hostFile,$requestFile)) { if ($taskPath.Contains('"') -or $taskPath -match '[\x00-\x1f\x7f]') { throw 'VERIFICATION_JOB_COMMAND_PATH' } }
$environmentPairs=@()
foreach ($environmentName in @('SystemRoot','WINDIR','COMSPEC','TEMP','TMP','PATH','USERDOMAIN','USERNAME','USERPROFILE','LOCALAPPDATA','APPDATA','ProgramFiles','ProgramData','HOMEDRIVE','HOMEPATH')) {
 $environmentValue=[Environment]::GetEnvironmentVariable($environmentName)
 if ($null -ne $environmentValue) { $environmentPairs+=($environmentName+'='+$environmentValue) }
}
$startupInfo=New-CimInstance -ClassName Win32_ProcessStartup -Namespace 'root/cimv2' -ClientOnly -Property @{ShowWindow=[uint16]0;CreateFlags=[uint32]8;EnvironmentVariables=[string[]]$environmentPairs}
$commandLine='"'+$hostFile+'" "'+$requestFile+'" '+$requestSha
$created=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$commandLine;CurrentDirectory=[string]$jobSpec.workingDirectory;ProcessStartupInformation=$startupInfo}
if ($created.ReturnValue -ne 0 -or $created.ProcessId -le 0) { throw 'VERIFICATION_JOB_RESTRICTED_PARENT_CREATE_FAILED' }
$receipt=[ordered]@{format='IDMS_VERIFICATION_RESTRICTED_NATIVE_HOST_CREATED_V1';jobId=$jobSpec.jobId;hostPid=[int]$created.ProcessId;hostSha256=$request.hostSha256;sourceSha256=(Get-FileHash -LiteralPath $sourceItem.FullName -Algorithm SHA256).Hash.ToLowerInvariant();requestSha256=$requestSha;hidden=$true;win32ReturnValue=[int]$created.ReturnValue;genericKillUsed=$false;at=[DateTimeOffset]::Now.ToString('o')}
$receiptFile=Join-Path $jobItem.DirectoryName 'restricted-host-created.private.json'
[IO.File]::WriteAllText($receiptFile,($receipt | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
$receipt | ConvertTo-Json -Compress
