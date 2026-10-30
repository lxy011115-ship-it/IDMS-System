$ErrorActionPreference = 'Stop'
$demoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $demoRoot
$nodeCandidate = 'C:\Program Files\nodejs'
if (Test-Path -LiteralPath "$nodeCandidate\node.exe") { $env:Path = "$nodeCandidate;" + $env:Path }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Please install Node.js 24 LTS first.' }
$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 24) { throw 'This demo requires Node.js 24 or newer.' }
if (-not (Test-Path -LiteralPath 'node_modules\exceljs')) {
  & npm.cmd ci --omit=dev --cache .npm-cache
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
Write-Host 'IDMS Demo: http://127.0.0.1:4010/'
Write-Host 'Keep this window running. Press Ctrl+C to stop.'
& node scripts/demo-runtime.mjs
