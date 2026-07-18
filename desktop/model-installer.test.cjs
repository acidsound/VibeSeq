const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { after, before, test } = require('node:test')

const {
  MARKER_FILENAME,
  StableAudioModelInstaller,
  snapshotDirectory,
} = require('./model-installer.cjs')

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')
const first = Buffer.from('abc')
const second = Buffer.from('def')
const complete = Buffer.concat([first, second])
const gpuConfig = Buffer.from('{"model":"medium"}\n')
const requests = []
let server
let baseUrl

before(async () => {
  server = http.createServer((request, response) => {
    const asset = new URL(request.url, 'http://127.0.0.1').pathname.slice(1)
    const value = asset === 'part-0'
      ? first
      : asset === 'part-1'
        ? second
        : asset === 'gpu-config.json'
          ? gpuConfig
          : null
    if (!value) {
      response.writeHead(404).end()
      return
    }
    requests.push({ asset, range: request.headers.range, authorization: request.headers.authorization })
    const offset = request.headers.range ? Number(request.headers.range.match(/^bytes=(\d+)-$/)?.[1]) : 0
    response.writeHead(offset > 0 ? 206 : 200, {
      'Content-Length': value.length - offset,
      ...(offset > 0 ? { 'Content-Range': `bytes ${offset}-${value.length - 1}/${value.length}` } : {}),
    })
    response.end(value.subarray(offset))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

const manifest = {
  schemaVersion: 1,
  bundleId: 'test-bundle',
  modelId: 'stabilityai/test-model',
  revision: '0123456789abcdef',
  release: { repository: 'acidsound/VibeSeq' },
  terms: { stability: 'https://stability.ai', gemma: 'https://ai.google.dev', source: 'https://huggingface.co' },
  commonFiles: [],
  variants: {
    'darwin-arm64': {
      label: 'Test MLX',
      release: { tag: 'test-macos', baseUrl },
      downloadBytes: complete.length,
      minimumFreeBytes: 100,
      files: [{
        destination: 'MLX/tiny.bin',
        size: complete.length,
        sha256: sha256(complete),
        parts: [
          { asset: 'part-0', size: first.length, sha256: sha256(first) },
          { asset: 'part-1', size: second.length, sha256: sha256(second) },
        ],
      }],
    },
  },
}

const gitBlobSha1 = (value) => crypto.createHash('sha1')
  .update(`blob ${value.length}\0`)
  .update(value)
  .digest('hex')

test('resumes a platform-specific release asset and installs the exact HF snapshot layout', async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeseq-model-installer-'))
  const installer = new StableAudioModelInstaller({
    storageRoot,
    manifest,
    platform: 'darwin',
    arch: 'arm64',
    releaseBaseUrl: baseUrl,
  })
  const root = snapshotDirectory(storageRoot, manifest)
  const target = path.join(root, 'MLX', 'tiny.bin')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(`${target}.vibeseq-download`, first.subarray(0, 1))

  const progress = []
  const result = await installer.install({
    accepted: true,
    onProgress: (value) => progress.push(value),
  })

  assert.equal(result.installed, true)
  assert.deepEqual(await fs.readFile(target), complete)
  assert.equal(requests[0].range, 'bytes=1-')
  assert.equal(requests[1].asset, 'part-1')
  assert.equal(JSON.parse(await fs.readFile(path.join(root, MARKER_FILENAME), 'utf8')).platform, 'darwin-arm64')
  assert.equal(progress.at(-1).phase, 'complete')
})

test('refuses installation when the redistributed model terms were not accepted', async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeseq-model-license-'))
  const installer = new StableAudioModelInstaller({ storageRoot, manifest, platform: 'darwin', arch: 'arm64' })
  await assert.rejects(() => installer.install({ accepted: false }), /must be accepted/)
})

test('reports an unsupported OS without downloading another platform model', async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeseq-model-platform-'))
  const installer = new StableAudioModelInstaller({ storageRoot, manifest, platform: 'freebsd', arch: 'x64' })
  assert.equal((await installer.status()).supported, false)
  await assert.rejects(() => installer.install({ accepted: true }), /not packaged for freebsd-x64/)
})

test('gated GPU model requires an ephemeral token and verifies Git blob digests', async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeseq-gpu-model-installer-'))
  const digest = gitBlobSha1(gpuConfig)
  const gpuManifest = {
    schemaVersion: 1,
    bundleId: 'gpu-test-bundle',
    modelId: 'stabilityai/stable-audio-3-medium',
    revision: '27b5a21',
    release: { repository: 'acidsound/VibeSeq' },
    terms: manifest.terms,
    commonFiles: [],
    variants: {
      'win32-x64': {
        label: 'Windows CUDA FA2',
        source: {
          kind: 'huggingface',
          baseUrl,
          accessUrl: 'https://huggingface.co/stabilityai/stable-audio-3-medium',
          requiresToken: true,
        },
        downloadBytes: gpuConfig.length,
        minimumFreeBytes: 100,
        files: [{
          destination: 'model_config.json',
          size: gpuConfig.length,
          gitSha1: digest,
          parts: [{ asset: 'gpu-config.json', size: gpuConfig.length, gitSha1: digest }],
        }],
      },
    },
  }
  const installer = new StableAudioModelInstaller({
    storageRoot,
    manifest: gpuManifest,
    platform: 'win32',
    arch: 'x64',
  })

  assert.equal((await installer.status()).requiresToken, true)
  await assert.rejects(
    () => installer.install({ accepted: true }),
    /requires a Hugging Face read token/,
  )
  const result = await installer.install({ accepted: true, token: 'ephemeral-test-token' })
  assert.equal(result.installed, true)
  const request = requests.find((entry) => entry.asset === 'gpu-config.json')
  assert.equal(request.authorization, 'Bearer ephemeral-test-token')
  await assert.doesNotReject(() => installer.install({ accepted: true }))
})

test('shipping manifest separates all OS releases and selects the expected model formats', () => {
  const shipping = require('./stable-audio-model-bundle.json')
  const gpuShipping = require('./stable-audio-gpu-model-bundle.json')
  const mac = shipping.variants['darwin-arm64']
  const windows = shipping.variants['win32-x64']
  const linux = shipping.variants['linux-x64']
  assert.notEqual(mac.release.tag, windows.release.tag)
  assert.notEqual(windows.release.tag, linux.release.tag)
  assert.ok(mac.files.every((file) => file.destination.startsWith('MLX/')))
  assert.ok(windows.files.every((file) => file.destination.startsWith('tflite/')))
  assert.ok(linux.files.every((file) => file.destination.startsWith('tflite/')))
  assert.deepEqual(
    linux.files.map(({ destination, size, sha256 }) => ({ destination, size, sha256 })),
    windows.files.map(({ destination, size, sha256 }) => ({ destination, size, sha256 })),
  )
  assert.ok(mac.files.flatMap((file) => file.parts).every((part) => part.size < 2 * 1024 * 1024 * 1024))
  assert.ok(windows.files.flatMap((file) => file.parts).every((part) => part.size < 2 * 1024 * 1024 * 1024))
  assert.ok(linux.files.flatMap((file) => file.parts).every((part) => part.size < 2 * 1024 * 1024 * 1024))
  const windowsGpu = gpuShipping.variants['win32-x64']
  assert.equal(windowsGpu.source.kind, 'huggingface')
  assert.equal(windowsGpu.source.requiresToken, true)
  assert.ok(windowsGpu.files.some((file) => file.destination === 'model.safetensors'))
  assert.ok(windowsGpu.files.every((file) => !file.destination.startsWith('tflite/')))
})
