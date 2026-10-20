param([ValidateSet('postgres','java','keycloak','mqtt','maven','ollama','all')][string]$Component='all')
$ErrorActionPreference='Stop'
$runtimeRoot=Join-Path $env:LOCALAPPDATA 'IDMS/runtime'
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
if ($Component -in @('postgres','all')) {
  $pgFolder=Join-Path $runtimeRoot 'pgsql'
  if (-not (Test-Path -LiteralPath (Join-Path $pgFolder 'bin/postgres.exe'))) {
    $pgArchive=Join-Path $runtimeRoot 'postgresql-16.10.zip'
    Write-Output 'Downloading PostgreSQL 16.10 Windows binaries from EnterpriseDB...'
    & curl.exe --fail --location --retry 3 --retry-delay 2 --max-time 600 --output $pgArchive 'https://get.enterprisedb.com/postgresql/postgresql-16.10-1-windows-x64-binaries.zip'
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL download failed' }
    $archiveHash=(Get-FileHash -LiteralPath $pgArchive -Algorithm SHA256).Hash
    Write-Output "PostgreSQL archive SHA256: $archiveHash (download record, not a publisher signature)"
    Expand-Archive -LiteralPath $pgArchive -DestinationPath $runtimeRoot -Force
  }
  & (Join-Path $pgFolder 'bin/postgres.exe') --version
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL executable verification failed' }
}
if ($Component -in @('java','all')) {
  $jdkFolder=Join-Path $runtimeRoot 'jdk-21'
  if (-not (Test-Path -LiteralPath (Join-Path $jdkFolder 'bin/java.exe'))) {
    $assets=Invoke-RestMethod 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse'
    $package=$assets[0].binary.package
    $jdkArchive=Join-Path $runtimeRoot 'jdk-21.zip'
    Write-Output 'Downloading Eclipse Temurin JDK 21...'
    Invoke-WebRequest -Uri $package.link -OutFile $jdkArchive -TimeoutSec 600
    if ((Get-FileHash -LiteralPath $jdkArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $package.checksum.ToLowerInvariant()) { throw 'JDK publisher SHA256 mismatch' }
    $extractFolder=Join-Path $runtimeRoot ('jdk-unpack-'+[guid]::NewGuid().ToString('N'))
    Expand-Archive -LiteralPath $jdkArchive -DestinationPath $extractFolder
    $extracted=Get-ChildItem -LiteralPath $extractFolder -Directory | Select-Object -First 1
    Move-Item -LiteralPath $extracted.FullName -Destination $jdkFolder
  }
  & (Join-Path $jdkFolder 'bin/java.exe') -version
}
if ($Component -in @('keycloak','all')) {
  $kcVersion='26.8.1'
  $kcFolder=Join-Path $runtimeRoot "keycloak-$kcVersion"
  if (-not (Test-Path -LiteralPath (Join-Path $kcFolder 'bin/kc.bat'))) {
    $kcArchive=Join-Path $runtimeRoot "keycloak-$kcVersion.zip"
    Write-Output "Downloading Keycloak $kcVersion from the official GitHub release..."
    & curl.exe --fail --location --retry 3 --retry-delay 2 --max-time 600 --output $kcArchive "https://github.com/keycloak/keycloak/releases/download/$kcVersion/keycloak-$kcVersion.zip"
    if ($LASTEXITCODE -ne 0) { throw 'Keycloak download failed' }
    $expectedHash='4cd312c889af358a819a74a6c6f068f9ea159a6959e49924607cec95cfd4c1a4'
    if ((Get-FileHash -LiteralPath $kcArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'Keycloak official release SHA256 mismatch' }
    Expand-Archive -LiteralPath $kcArchive -DestinationPath $runtimeRoot -Force
    Write-Output 'Keycloak archive matches the SHA256 published by the official release API.'
  }
  Write-Output "Keycloak installed at $kcFolder (not started, no public listener)."
}
if ($Component -in @('mqtt','all')) {
  $mqttFolder=Join-Path $runtimeRoot 'mosquitto-2.1.2'
  if (-not (Test-Path -LiteralPath (Join-Path $mqttFolder 'mosquitto.exe'))) {
    # Extract official binaries only. Never execute the Mosquitto installer: its default sections alter global services/environment.
    $sevenVersion='26.04'
    $sevenRelease=Invoke-RestMethod "https://api.github.com/repos/ip7z/7zip/releases/tags/$sevenVersion"
    $sevenBootstrap=Join-Path $runtimeRoot '7zr.exe'
    $sevenInstaller=Join-Path $runtimeRoot '7z2604-x64.exe'
    foreach($entry in @(@{Name='7zr.exe';Target=$sevenBootstrap},@{Name='7z2604-x64.exe';Target=$sevenInstaller})) {
      $asset=$sevenRelease.assets | Where-Object { $_.name -eq $entry.Name } | Select-Object -First 1
      if (-not $asset -or $asset.digest -notmatch '^sha256:([a-f0-9]{64})$') { throw 'Official 7-Zip release digest is unavailable' }
      $expectedHash=$Matches[1]
      & curl.exe --fail --location --retry 3 --max-time 300 --output $entry.Target $asset.browser_download_url
      if ($LASTEXITCODE -ne 0 -or (Get-FileHash -LiteralPath $entry.Target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw '7-Zip download/digest check failed' }
    }
    $sevenFolder=Join-Path $runtimeRoot '7zip-extractor-26.04'
    & $sevenBootstrap x $sevenInstaller "-o$sevenFolder" -y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not extract portable 7-Zip helper' }
    $mqttArchive=Join-Path $runtimeRoot 'mosquitto-2.1.2-windows-x64.exe'
    & curl.exe --fail --location --retry 3 --max-time 300 --output $mqttArchive 'https://mosquitto.org/files/binary/win64/mosquitto-2.1.2-install-windows-x64.exe'
    if ($LASTEXITCODE -ne 0) { throw 'Mosquitto official download failed' }
    $mqttSignature=Get-AuthenticodeSignature -LiteralPath $mqttArchive
    if ($mqttSignature.Status -in @('HashMismatch','NotTrusted')) { throw 'Mosquitto publisher signature verification failed' }
    Write-Output "Mosquitto official HTTPS archive SHA256: $((Get-FileHash -LiteralPath $mqttArchive -Algorithm SHA256).Hash); Authenticode: $($mqttSignature.Status). An unsigned archive hash is only a download record."
    & (Join-Path $sevenFolder '7z.exe') x $mqttArchive "-o$mqttFolder" -y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Mosquitto portable extraction failed' }
  }
  & (Join-Path $mqttFolder 'mosquitto.exe') -h | Select-Object -First 2
  if ($LASTEXITCODE -ne 0) { throw 'Mosquitto executable check failed' }
  Write-Output "Mosquitto extracted at $mqttFolder; no installer, global environment, service or listener was started."
}
if ($Component -in @('maven','all')) {
  $mavenVersion='3.9.11'
  $mavenFolder=Join-Path $runtimeRoot "apache-maven-$mavenVersion"
  if (-not (Test-Path -LiteralPath (Join-Path $mavenFolder 'bin/mvn.cmd'))) {
    $mavenArchive=Join-Path $runtimeRoot "apache-maven-$mavenVersion-bin.zip"
    $mavenUrl="https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/$mavenVersion/apache-maven-$mavenVersion-bin.zip"
    & curl.exe --fail --location --retry 3 --max-time 300 --output $mavenArchive $mavenUrl
    if ($LASTEXITCODE -ne 0) { throw 'Maven download failed' }
    $expectedMavenHash=(& curl.exe --fail --location --retry 3 --max-time 60 "$mavenUrl.sha512").Trim().Split(' ')[0]
    if ($LASTEXITCODE -ne 0 -or $expectedMavenHash -notmatch '^[a-fA-F0-9]{128}$' -or (Get-FileHash -LiteralPath $mavenArchive -Algorithm SHA512).Hash.ToLowerInvariant() -ne $expectedMavenHash.ToLowerInvariant()) { throw 'Maven published SHA512 mismatch' }
    Expand-Archive -LiteralPath $mavenArchive -DestinationPath $runtimeRoot
  }
  $priorJavaHome=$env:JAVA_HOME
  try { $env:JAVA_HOME=Join-Path $runtimeRoot 'jdk-21'; & (Join-Path $mavenFolder 'bin/mvn.cmd') -version; if($LASTEXITCODE -ne 0){throw 'Maven verification failed'} } finally { $env:JAVA_HOME=$priorJavaHome }
}
if ($Component -in @('ollama','all')) {
  $ollamaVersion='0.40.4'
  $ollamaFolder=Join-Path $runtimeRoot "ollama-$ollamaVersion"
  if (-not (Test-Path -LiteralPath (Join-Path $ollamaFolder 'ollama.exe'))) {
    $ollamaArchive=Join-Path $runtimeRoot "ollama-$ollamaVersion-windows-amd64.zip"
    $ollamaHash='7485a1172f8527db4342a63521b9342fc466185ff0855da378cc864ecf6354cf'
    Write-Output 'Downloading official Ollama standalone CLI and NVIDIA libraries (about 1.47 GB)...'
    & curl.exe --fail --location --continue-at - --retry 3 --retry-delay 2 --max-time 1800 --output $ollamaArchive "https://github.com/ollama/ollama/releases/download/v$ollamaVersion/ollama-windows-amd64.zip"
    if ($LASTEXITCODE -ne 0) { throw 'Ollama download incomplete; preserve the archive for resumable download' }
    if ((Get-FileHash -LiteralPath $ollamaArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ollamaHash) { throw 'Ollama official release SHA256 mismatch; do not execute this archive' }
    $sevenTool=Join-Path $runtimeRoot '7zip-extractor-26.04/7z.exe'
    if (Test-Path -LiteralPath $sevenTool) {
      & $sevenTool x $ollamaArchive "-o$ollamaFolder" -y | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'Ollama standalone extraction failed' }
    } else { Expand-Archive -LiteralPath $ollamaArchive -DestinationPath $ollamaFolder }
    Write-Output 'Ollama archive matches the SHA256 published by the official release API.'
  }
  & (Join-Path $ollamaFolder 'ollama.exe') --version
  if ($LASTEXITCODE -ne 0) { throw 'Ollama CLI check failed' }
}
Write-Output "Runtime directory: $runtimeRoot. No system PATH or startup services changed."
