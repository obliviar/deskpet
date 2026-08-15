$ErrorActionPreference = 'Stop'

$appDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repositoryRoot = (Resolve-Path (Join-Path $appDirectory '..\..')).Path
$releaseDirectory = Join-Path $appDirectory 'release'
$unpackedDirectory = Join-Path $releaseDirectory 'win-unpacked'
$executablePath = Join-Path $unpackedDirectory 'DeskPet.exe'
$package = Get-Content -LiteralPath (Join-Path $appDirectory 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version

if (-not (Test-Path -LiteralPath $executablePath)) {
  throw "Packaged executable not found: $executablePath"
}

$rceditPath = $env:DESKPET_RCEDIT_PATH
if (-not $rceditPath) {
  $winCodeSignCache = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign'
  $rceditPath = Get-ChildItem -LiteralPath $winCodeSignCache -Recurse -File -Filter 'rcedit-x64.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.Length -gt 1MB } |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $rceditPath -or -not (Test-Path -LiteralPath $rceditPath)) {
  throw 'rcedit-x64.exe was not found. Set DESKPET_RCEDIT_PATH to a local copy before packaging.'
}

& $rceditPath $executablePath `
  --set-file-version $version `
  --set-product-version $version `
  --set-version-string ProductName 'DeskPet' `
  --set-version-string FileDescription 'DeskPet AI Desktop Companion' `
  --set-version-string InternalName 'DeskPet' `
  --set-version-string OriginalFilename 'DeskPet.exe'
if ($LASTEXITCODE -ne 0) {
  throw "rcedit failed with exit code $LASTEXITCODE"
}

$versionInfo = (Get-Item -LiteralPath $executablePath).VersionInfo
if ($versionInfo.FileVersion -ne $version -or $versionInfo.ProductVersion -ne $version) {
  throw "Version verification failed: FileVersion=$($versionInfo.FileVersion), ProductVersion=$($versionInfo.ProductVersion)"
}

$sevenZipPath = Get-ChildItem -LiteralPath (Join-Path $repositoryRoot 'node_modules\.pnpm') -Recurse -File -Filter '7za.exe' |
  Where-Object { $_.FullName -match '\\win\\x64\\7za\.exe$' } |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $sevenZipPath) {
  throw 'The x64 7za.exe bundled with 7zip-bin was not found. Run pnpm install before packaging.'
}

$archivePath = Join-Path $releaseDirectory "DeskPet-$version-win.zip"
if (Test-Path -LiteralPath $archivePath) {
  Remove-Item -LiteralPath $archivePath -Force
}

Push-Location $unpackedDirectory
try {
  & $sevenZipPath a -tzip -mx=5 -mmt=on $archivePath '.\*'
  if ($LASTEXITCODE -ne 0) {
    throw "7-Zip failed with exit code $LASTEXITCODE"
  }
}
finally {
  Pop-Location
}

Write-Host "Versioned package created: $archivePath"
Write-Host "DeskPet.exe FileVersion=$($versionInfo.FileVersion), ProductVersion=$($versionInfo.ProductVersion)"
