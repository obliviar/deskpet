param(
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$appDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$electronCommand = Join-Path $appDirectory 'node_modules\.bin\electron.cmd'
if (-not (Test-Path -LiteralPath $electronCommand)) {
  throw "Electron command not found: $electronCommand"
}

if (-not $SkipBuild) {
  & pnpm.cmd build
  if ($LASTEXITCODE -ne 0) {
    throw "Electron build failed with exit code $LASTEXITCODE"
  }
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("deskpet-v4-smoke-{0}" -f [guid]::NewGuid().ToString('N'))
$dataPath = Join-Path $testRoot 'data'
$logPath = Join-Path $testRoot 'boot.log'
New-Item -ItemType Directory -Path $dataPath | Out-Null

$items = @(
  @{
    id = 'smoke-manual-name'
    content = '用户姓名：小秦'
    metadata = @{ kind = 'identity'; cardinality = 'single' }
    status = 'active'
    origin = 'manual'
    importance = 0.9
    confidence = 1.0
    accessCount = 2
    sourceMessageIds = @()
    sourceAttachmentIds = @()
    sharePolicy = 'allow-remote'
    sensitivity = 'normal'
    scope = @{ ownerId = 'local-user'; agentId = 'deskpet' }
    embedding = @(0.1)
    embeddingModel = 'local-hash-v2'
    createdAt = 1700000000000
    updatedAt = 1700000001000
  }
  @{
    id = 'smoke-automatic-tea'
    content = '用户喜欢茶'
    metadata = @{ kind = 'preference'; cardinality = 'multiple' }
    status = 'active'
    origin = 'automatic'
    importance = 0.7
    confidence = 0.8
    accessCount = 0
    sourceMessageIds = @('message-1')
    sourceAttachmentIds = @()
    sharePolicy = 'local-only'
    sensitivity = 'private'
    scope = @{ ownerId = 'local-user'; agentId = 'deskpet'; sessionId = 'session-a' }
    embedding = @(0.2)
    embeddingModel = 'local-hash-v2'
    createdAt = 1700000002000
    updatedAt = 1700000003000
  }
)
$payload = @{ version = 3; items = $items } | ConvertTo-Json -Depth 10 -Compress
[IO.File]::WriteAllText((Join-Path $dataPath 'memories.json'), $payload, [Text.UTF8Encoding]::new($false))

function Invoke-SmokeLaunch {
  & $electronCommand .
  if ($LASTEXITCODE -ne 0) {
    throw "Electron smoke launch failed with exit code $LASTEXITCODE"
  }
}

try {
  $env:DESKPET_USER_DATA_DIR = $dataPath
  $env:DESKPET_BOOT_LOG = $logPath
  $env:DESKPET_SMOKE_TEST = 'true'
  $env:DESKPET_MEMORY = 'true'

  Invoke-SmokeLaunch
  if (-not (Select-String -Path $logPath -Pattern 'Memory V4 shadow migrated: 2 facts, 1 warnings' -Quiet)) {
    throw 'The first launch did not migrate two V3 facts into the V4 shadow.'
  }
  if (Test-Path -LiteralPath (Join-Path $dataPath 'memories.json')) {
    throw 'The verified V3 encryption migration left the legacy plaintext file behind.'
  }
  foreach ($file in @('memories.enc', 'memory-key.json', 'memory-v4.enc', 'memory-v4-key.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $dataPath $file))) {
      throw "Expected encrypted memory artifact is missing: $file"
    }
  }

  Invoke-SmokeLaunch
  if (-not (Select-String -Path $logPath -Pattern 'Memory V4 shadow verified: 2 facts, 1 warnings' -Quiet)) {
    throw 'The second launch did not verify the existing idempotent V4 shadow.'
  }

  $v3Path = Join-Path $dataPath 'memories.enc'
  $v3HashBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $v3Path).Hash
  [IO.File]::WriteAllText((Join-Path $dataPath 'memory-v4.enc'), '{corrupt-v4', [Text.UTF8Encoding]::new($false))
  Invoke-SmokeLaunch
  $v3HashAfter = (Get-FileHash -Algorithm SHA256 -LiteralPath $v3Path).Hash
  if ($v3HashBefore -ne $v3HashAfter) {
    throw 'V3 changed while the intentionally damaged V4 shadow was rejected.'
  }
  if (-not (Select-String -Path $logPath -Pattern 'Memory V4 shadow migration failed' -Quiet)) {
    throw 'The damaged V4 shadow did not enter the expected non-fatal fallback path.'
  }
  if ((Select-String -Path $logPath -Pattern 'renderer finished loading').Count -ne 3) {
    throw 'The Electron renderer did not finish loading on all three launches.'
  }

  Write-Output 'Memory V4 Electron smoke test passed: migration, idempotence, encrypted artifacts, renderer startup, and V3-safe V4 failure fallback.'
}
finally {
  Remove-Item Env:DESKPET_USER_DATA_DIR,Env:DESKPET_BOOT_LOG,Env:DESKPET_SMOKE_TEST,Env:DESKPET_MEMORY -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $testRoot) {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    $name = [IO.Path]::GetFileName($resolved)
    $insideTemporaryRoot = $resolved.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)
    $hasExpectedName = $name.StartsWith('deskpet-v4-smoke-')
    if (-not $insideTemporaryRoot -or -not $hasExpectedName) {
      throw "Refusing to clean an unvalidated smoke-test path: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
