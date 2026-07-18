const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const { MuscriptorCacheVerifier, snapshotDirectory, verificationFiles } = require('./muscriptor-importer.cjs')

const safetensorsFixture = () => {
  const raw = JSON.stringify({ weight: { dtype: 'F32', shape: [2], data_offsets: [0, 8] } })
  const padding = ' '.repeat((8 - (Buffer.byteLength(raw) % 8)) % 8)
  const header = Buffer.from(raw + padding)
  const length = Buffer.alloc(8)
  length.writeBigUInt64LE(BigInt(header.length))
  return Buffer.concat([length, header, Buffer.alloc(8)])
}

const manifest = (modelSize) => ({
  modelId: 'MuScriptor/test-medium',
  revision: 'f32236969308476e01fd3aae67357de5feb05a2d',
  files: [
    { name: 'config.json', size: 27, kind: 'config', modelType: 'muscriptor' },
    { name: 'model.safetensors', size: modelSize, kind: 'safetensors', dtype: 'F32', parameterCount: 2 },
  ],
})

test('validates both gated files already placed in the exact HF snapshot', async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeseq-muscriptor-storage-'))
  const config = Buffer.from('{"model_type":"muscriptor"}')
  const model = safetensorsFixture()
  const modelManifest = manifest(model.length)
  const root = snapshotDirectory(storageRoot, modelManifest)
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(path.join(root, 'config.json'), config)
  await fs.writeFile(path.join(root, 'model.safetensors'), model)
  const verifier = new MuscriptorCacheVerifier({ storageRoot, manifest: modelManifest })

  const result = await verifier.verify()

  assert.equal(result.verified, true)
  assert.equal(result.cacheDirectory, root)
})

test('reports a required file missing from the cache without opening a picker', async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeseq-muscriptor-missing-'))
  const verifier = new MuscriptorCacheVerifier({ storageRoot, manifest: manifest(safetensorsFixture().length) })
  await verifier.ensureCacheDirectory()
  await assert.rejects(() => verifier.verify(), /Missing config\.json in the MuScriptor cache folder/)
})

test('shipping manifest pins one release bundle for every desktop platform', () => {
  const shipping = require('./muscriptor-model-bundle.json')
  assert.equal(shipping.revision, 'f32236969308476e01fd3aae67357de5feb05a2d')
  assert.equal(shipping.terms.license, 'https://creativecommons.org/licenses/by-nc/4.0/legalcode.en')
  assert.deepEqual(verificationFiles(shipping, 'darwin', 'arm64').map((file) => [file.name, file.size]), [
    ['config.json', 126],
    ['model.safetensors', 1228144472],
  ])
  assert.deepEqual(
    verificationFiles(shipping, 'linux', 'x64').map((file) => [file.name, file.size]),
    verificationFiles(shipping, 'win32', 'x64').map((file) => [file.name, file.size]),
  )
})
