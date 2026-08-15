import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildModelArtifactManifest,
  inspectModelArtifactManifest,
  type ModelArtifactIdentity,
  verifyModelArtifactManifest,
  writeModelArtifactManifestAtomic,
} from './model-artifact-integrity'

const directories: string[] = []
const identity: ModelArtifactIdentity = {
  fingerprint: 'model@revision:q8:test',
  model: 'model',
  revision: 'revision',
  dtype: 'q8',
  runtime: { transformers: '3.8.1', onnx: '1.21.0' },
  expectedDimension: 3,
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('model artifact integrity', () => {
  it('builds, atomically writes and verifies a SHA-256 manifest', async () => {
    const root = temporaryRoot()
    const relativePath = 'model/revision/onnx/model_q8.onnx'
    writeArtifact(root, relativePath, 'verified model bytes')
    const manifest = await buildModelArtifactManifest(root, identity, [relativePath], {
      version: 'probe-v1', dimension: 3, normalized: true,
    })
    const manifestPath = join(root, 'model.manifest.json')
    writeModelArtifactManifestAtomic(manifestPath, manifest)

    expect(inspectModelArtifactManifest(root, manifestPath, identity).state).toBe('present')
    await expect(verifyModelArtifactManifest(root, manifestPath, identity)).resolves.toMatchObject({
      ok: true, state: 'ready', checkedFiles: 1, checkedBytes: 'verified model bytes'.length,
    })
    expect(JSON.parse(readFileSync(manifestPath, 'utf-8')).files[0].sha256).toBe(
      createHash('sha256').update('verified model bytes').digest('hex'),
    )
  })

  it('detects same-size corruption instead of trusting file existence or size', async () => {
    const root = temporaryRoot()
    const relativePath = 'model/revision/config.json'
    writeArtifact(root, relativePath, 'original')
    const manifest = await buildModelArtifactManifest(root, identity, [relativePath], {
      version: 'probe-v1', dimension: 3, normalized: true,
    })
    const manifestPath = join(root, 'manifest.json')
    writeModelArtifactManifestAtomic(manifestPath, manifest)
    writeArtifact(root, relativePath, 'tampered')

    expect(inspectModelArtifactManifest(root, manifestPath, identity).state).toBe('present')
    await expect(verifyModelArtifactManifest(root, manifestPath, identity)).resolves.toMatchObject({
      ok: false, state: 'corrupt', error: expect.stringContaining('SHA-256 mismatch'),
    })
  })

  it('rejects incompatible runtime and path traversal manifests', async () => {
    const root = temporaryRoot()
    const relativePath = 'model/revision/config.json'
    writeArtifact(root, relativePath, '{}')
    const manifest = await buildModelArtifactManifest(root, identity, [relativePath], {
      version: 'probe-v1', dimension: 3, normalized: true,
    })
    const manifestPath = join(root, 'manifest.json')
    writeModelArtifactManifestAtomic(manifestPath, {
      ...manifest,
      runtime: { ...manifest.runtime, transformers: '4.0.0' },
    })
    await expect(verifyModelArtifactManifest(root, manifestPath, identity)).resolves.toMatchObject({
      ok: false, state: 'incompatible',
    })

    writeModelArtifactManifestAtomic(manifestPath, {
      ...manifest,
      files: [{ ...manifest.files[0]!, path: '../outside.onnx' }],
    })
    await expect(verifyModelArtifactManifest(root, manifestPath, identity)).resolves.toMatchObject({
      ok: false, state: 'corrupt', error: expect.stringContaining('Unsafe model artifact path'),
    })
  })

  it('rejects non-regular artifacts', async () => {
    const root = temporaryRoot()
    mkdirSync(join(root, 'model-directory'))
    await expect(buildModelArtifactManifest(root, identity, ['model-directory'], {
      version: 'probe-v1', dimension: 3, normalized: true,
    })).rejects.toThrow('not a regular file')
  })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'deskpet-model-integrity-'))
  directories.push(root)
  return root
}

function writeArtifact(root: string, relativePath: string, payload: string): void {
  const path = join(root, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, payload)
}
