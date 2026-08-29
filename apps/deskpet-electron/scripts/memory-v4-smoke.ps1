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
$workerBundle = Join-Path $appDirectory 'dist\main\memory-v4-shadow-worker.js'
if (-not (Test-Path -LiteralPath $workerBundle)) {
  throw "Memory V4 worker bundle not found: $workerBundle"
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

function Get-Sha256Hex([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '')
  }
  finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

try {
  $env:DESKPET_USER_DATA_DIR = $dataPath
  $env:DESKPET_BOOT_LOG = $logPath
  $env:DESKPET_SMOKE_TEST = 'true'
  $env:DESKPET_MEMORY = 'true'
  $env:DESKPET_MEMORY_V4_INTERNAL_REVIEW = 'true'
  $env:DESKPET_MEMORY_V4_READ_MODE = 'auto'
  $env:DESKPET_SMOKE_EXPECT_ROLLOUT_STAGE = 'internal'

  Invoke-SmokeLaunch
  if (-not (Select-String -Path $logPath -Pattern 'Memory V4 official read controller ready: auto, per-request V3 fallback enabled' -Quiet)) {
    throw 'The default-auto V4 official read controller was not attached to AgentRuntime.'
  }
  if (-not (Select-String -Path $logPath -Pattern 'Memory V4 official read smoke completed: mode auto, source v4, fallback none, memories 1' -Quiet)) {
    $observedOfficialReads = (Select-String -Path $logPath -Pattern 'Memory V4 (official read|worker) smoke').Line -join ' | '
    throw "Auto mode did not inject the accepted V4 fact through the official read controller. Observed: $observedOfficialReads"
  }
  if (-not (Select-String -Path $logPath -Pattern 'Memory V4 internal candidate review enabled; review does not modify official read mode' -Quiet)) {
    throw 'The opt-in V4 internal candidate review controller was not initialized.'
  }
  if (-not (Select-String -Path $logPath -Pattern 'Memory V4 rollout smoke verified: internal, read mode auto' -Quiet)) {
    throw 'The effective Internal review stage and default auto read mode were not reported.'
  }
  if (-not (Select-String -Path $logPath -Pattern 'Memory V4 shadow migrated: 2 facts, 1 warnings' -Quiet)) {
    throw 'The first launch did not migrate two V3 facts into the V4 shadow.'
  }
  if (-not (Select-String -Path $logPath -Pattern 'Memory V4 dual-write ready: 2/2 facts reconciled, 0 tombstoned' -Quiet)) {
    throw 'The first launch did not reconcile the migrated facts into the V4 dual-write shadow.'
  }
  if (-not (Select-String -Path $logPath -Pattern 'Memory V4 diff audit: 100.0000% exact, 0 issues' -Quiet)) {
    throw 'The first launch did not pass the complete V3/V4 consistency audit.'
  }
  if (Test-Path -LiteralPath (Join-Path $dataPath 'memories.json')) {
    throw 'The verified V3 encryption migration left the legacy plaintext file behind.'
  }
  foreach ($file in @('memories.enc', 'memory-key.json', 'memory-embeddings.enc', 'memory-embedding-key.json', 'memory-v4.enc', 'memory-v4-key.json', 'memory-v4.enc.journal', 'memory-v4-shadow-eval.enc', 'memory-v4-shadow-eval-key.json', 'memory-v4-shadow-eval-hmac-key.json', 'memory-v4-internal-feedback.enc', 'memory-v4-internal-feedback-key.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $dataPath $file))) {
      throw "Expected encrypted memory artifact is missing: $file"
    }
  }

  Invoke-SmokeLaunch
  if ((Select-String -Path $logPath -Pattern 'Memory V4 dual-write ready: 2/2 facts reconciled, 0 tombstoned').Count -ne 2) {
    throw 'The second launch did not preserve and idempotently reconcile the existing V4 dual-write shadow.'
  }
  if ((Select-String -Path $logPath -Pattern 'Memory V4 diff audit: 100.0000% exact, 0 issues').Count -ne 2) {
    throw 'The restart did not preserve complete V3/V4 audit consistency.'
  }

  $env:DESKPET_SMOKE_PURGE_ID = 'smoke-manual-name'
  Invoke-SmokeLaunch
  Remove-Item Env:DESKPET_SMOKE_PURGE_ID -ErrorAction SilentlyContinue
  if (-not (Select-String -Path $logPath -Pattern 'Memory purge completed: smoke-manual-name, V3 removed=True' -Quiet)) {
    throw 'The strong-confirm purge path did not remove the selected V3 memory.'
  }
  if (-not (Select-String -Path $logPath -Pattern 'smoke purge report: .*"residualCount":0.*"checkpointCompacted":true.*"backupsScrubbed":true' -Quiet)) {
    throw 'The strong-confirm purge path did not produce a zero-residual durability report.'
  }
  if (Test-Path -LiteralPath (Join-Path $dataPath 'memory-v4.enc.journal')) {
    throw 'The irreversible purge left a recoverable V4 journal behind.'
  }

  Invoke-SmokeLaunch
  if (-not (Select-String -Path $logPath -Pattern 'Memory V4 dual-write ready: 1/1 facts reconciled, 0 tombstoned' -Quiet)) {
    throw 'The post-purge restart did not preserve the single remaining V3 fact.'
  }
  if (-not (Select-String -Path $logPath -Pattern 'Memory V4 diff audit: 100.0000% exact, 0 issues' -Quiet)) {
    throw 'The post-purge restart did not preserve V3/V4 audit consistency.'
  }

  $v3Path = Join-Path $dataPath 'memories.enc'
  $v3HashBefore = Get-Sha256Hex $v3Path
  Remove-Item Env:DESKPET_SMOKE_EXPECT_ROLLOUT_STAGE -ErrorAction SilentlyContinue
  [IO.File]::WriteAllText((Join-Path $dataPath 'memory-v4.enc'), '{corrupt-v4', [Text.UTF8Encoding]::new($false))
  Invoke-SmokeLaunch
  $v3HashAfter = Get-Sha256Hex $v3Path
  if ($v3HashBefore -ne $v3HashAfter) {
    throw 'V3 changed while the intentionally damaged V4 shadow was rejected.'
  }
  if (-not (Select-String -Path $logPath -Pattern 'Memory V4 shadow initialization failed' -Quiet)) {
    throw 'The damaged V4 shadow did not enter the expected non-fatal fallback path.'
  }
  if (-not (Select-String -Path $logPath -Pattern 'Memory V4 official read smoke completed: mode auto, source v3' -Quiet)) {
    throw 'Auto mode did not fall back to V3 after the V4 shadow was intentionally damaged.'
  }

  [IO.File]::WriteAllText((Join-Path $dataPath 'memory-embeddings.enc'), '{corrupt-embedding-index', [Text.UTF8Encoding]::new($false))
  Invoke-SmokeLaunch
  if (-not (Select-String -Path $logPath -Pattern 'semantic side index disabled' -Quiet)) {
    throw 'The damaged derived embedding index did not enter the expected local-hash fallback path.'
  }

  $semanticModelDirectory = Join-Path $dataPath 'models\memory'
  $semanticArtifactPath = Join-Path $semanticModelDirectory 'Xenova\bge-small-zh-v1.5\fcecc3c5fef6becfa2b2bdda15c1c938857be534\config.json'
  New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($semanticArtifactPath)) -Force | Out-Null
  [IO.File]::WriteAllText($semanticArtifactPath, '{}', [Text.UTF8Encoding]::new($false))
  $badManifest = @{
    version = 1
    fingerprint = 'Xenova/bge-small-zh-v1.5@fcecc3c5fef6becfa2b2bdda15c1c938857be534:q8:mean-normalized:v1'
    model = 'Xenova/bge-small-zh-v1.5'
    revision = 'fcecc3c5fef6becfa2b2bdda15c1c938857be534'
    dtype = 'q8'
    runtime = @{ transformers = '3.8.1'; onnxRuntimeNode = '1.21.0' }
    expectedDimension = 512
    files = @(@{
      path = 'Xenova/bge-small-zh-v1.5/fcecc3c5fef6becfa2b2bdda15c1c938857be534/config.json'
      size = 2
      sha256 = ('0' * 64)
    })
    probe = @{ version = 'bge-small-zh-probe-v1'; dimension = 512; normalized = $true }
    installedAt = '2026-08-15T00:00:00.000Z'
    verifiedAt = '2026-08-15T00:00:00.000Z'
  } | ConvertTo-Json -Depth 10
  [IO.File]::WriteAllText((Join-Path $semanticModelDirectory 'bge-small-zh-v1.5.manifest.json'), $badManifest, [Text.UTF8Encoding]::new($false))
  $semanticSettings = @{
    extractionMode = 'rules'
    semanticEnabled = $true
    imageMemoryEnabled = $true
    remotePolicy = 'normal-only'
  } | ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $dataPath 'memory-settings.json'), $semanticSettings, [Text.UTF8Encoding]::new($false))
  Invoke-SmokeLaunch
  if (-not (Select-String -Path $logPath -Pattern 'semantic startup verification failed: Model artifact SHA-256 mismatch' -Quiet)) {
    throw 'The tampered semantic model did not fail startup SHA-256 verification.'
  }
  $savedMemorySettings = Get-Content -LiteralPath (Join-Path $dataPath 'memory-settings.json') -Raw | ConvertFrom-Json
  if ($savedMemorySettings.semanticEnabled -ne $false) {
    throw 'The tampered semantic model remained enabled instead of falling back to local hash.'
  }
  if ((Select-String -Path $logPath -Pattern 'renderer finished loading').Count -ne 7) {
    throw 'The Electron renderer did not finish loading on all seven launches.'
  }
  if ((Select-String -Path $logPath -Pattern 'Memory V4 worker smoke completed').Count -lt 4) {
    throw 'The isolated Memory V4 worker did not execute on every healthy shadow launch.'
  }

  Write-Output 'Memory V4 Electron smoke test passed: default-auto official V4 read, per-request V3 fallback, isolated worker execution, migration, journal replay, 100% diff audit, strong-confirm zero-residual purge, post-purge restart, encrypted artifacts, renderer startup, and safe V4/embedding-index/model-integrity failure fallbacks.'
}
finally {
  Remove-Item Env:DESKPET_USER_DATA_DIR,Env:DESKPET_BOOT_LOG,Env:DESKPET_SMOKE_TEST,Env:DESKPET_SMOKE_PURGE_ID,Env:DESKPET_SMOKE_EXPECT_ROLLOUT_STAGE,Env:DESKPET_MEMORY,Env:DESKPET_MEMORY_V4_INTERNAL_REVIEW,Env:DESKPET_MEMORY_V4_READ_MODE -ErrorAction SilentlyContinue
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
