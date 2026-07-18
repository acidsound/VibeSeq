const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const {
  CUDA_RUNTIME_BUNDLE,
  CudaRuntimeInstaller,
  runtimePaths,
} = require('./cuda-runtime-installer.cjs')

const fixtureProject = async (root) => {
  const projectRoot = path.join(root, 'desktop', 'cuda-runtime')
  const packageRoot = path.join(root, 'server', 'vibeseq_inference')
  await fs.mkdir(projectRoot, { recursive: true })
  await fs.mkdir(packageRoot, { recursive: true })
  await fs.writeFile(path.join(projectRoot, 'pyproject.toml'), '[project]\nname="fixture"\n')
  await fs.writeFile(path.join(projectRoot, 'uv.lock'), 'version = 1\n')
  await fs.writeFile(path.join(root, 'server', 'pyproject.toml'), '[project]\nname="server"\n')
  await fs.writeFile(path.join(packageRoot, '__init__.py'), 'VERSION = 1\n')
  return { projectRoot, packageRoot }
}

test('installs the pinned CUDA runtime under VibeSeq Data and invalidates changed app code', async () => {
  const resourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeseq-cuda-resource-'))
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeseq-cuda-storage-'))
  const { projectRoot, packageRoot } = await fixtureProject(resourceRoot)
  const paths = runtimePaths(storageRoot)
  await fs.mkdir(path.dirname(paths.uv), { recursive: true })
  await fs.writeFile(paths.uv, 'fixture executable')
  const commands = []
  const runImpl = async (options) => {
    commands.push(options)
    if (options.args[0] === 'sync') {
      const paths = runtimePaths(storageRoot)
      await fs.mkdir(path.dirname(paths.python), { recursive: true })
      await fs.writeFile(paths.python, 'fixture python')
      await fs.writeFile(
        paths.configuration,
        `home = ${path.join(storageRoot, 'runtimes', 'python', 'cpython-fixture')}\n`,
      )
    }
    return ''
  }
  const installer = new CudaRuntimeInstaller({
    storageRoot,
    projectRoot,
    platform: 'win32',
    arch: 'x64',
    runImpl,
  })

  const installed = await installer.install({})
  assert.equal(installed.installed, true)
  assert.equal(installed.bundleId, CUDA_RUNTIME_BUNDLE)
  assert.ok(installed.python.startsWith(path.join(storageRoot, 'runtimes')))
  assert.deepEqual(commands[0].args, ['cache', 'clean', 'flash-attn'])
  assert.deepEqual(commands[1].args, [
    'sync', '--project', projectRoot, '--locked', '--python', '3.12.10',
    '--extra', 'stable-audio', '--inexact',
    '--refresh-package', 'flash-attn', '--reinstall-package', 'flash-attn',
  ])
  assert.equal(commands[1].env.UV_PROJECT_ENVIRONMENT, runtimePaths(storageRoot).environment)
  assert.deepEqual(commands[2].args.slice(0, 5), [
    'pip', 'install', '--python', runtimePaths(storageRoot).python, '--no-deps',
  ])
  assert.ok(commands[2].args.includes('--no-build-isolation'))
  assert.ok(commands[2].args.includes('--reinstall'))
  assert.doesNotMatch(commands[3].args[1], /TranscriptionModel/)
  assert.doesNotMatch(commands[3].args[1], /import muscriptor/)
  assert.match(commands[3].args[1], /CudaModelManager/)
  assert.match(commands[3].args[1], /StableAudioModel/)
  assert.match(commands[3].args[1], /flash_attn_func/)
  assert.match(commands[3].args[1], /torch\.cuda\.synchronize/)
  assert.equal(installed.flashAttentionInstalled, true)
  assert.equal(installed.muscriptorInstalled, false)

  await fs.writeFile(path.join(packageRoot, '__init__.py'), 'VERSION = 2\n')
  assert.equal((await installer.status()).installed, false)
})

test('repairs the isolated environment when the whole installation is moved', async () => {
  const resourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeseq-cuda-resource-'))
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeseq-cuda-relocate-'))
  const oldStorage = path.join(parent, 'old', 'VibeSeq Data')
  const newStorage = path.join(parent, 'new', 'VibeSeq Data')
  const { projectRoot } = await fixtureProject(resourceRoot)
  const digest = require('./cuda-runtime-installer.cjs').runtimeProjectDigest
  const oldPaths = runtimePaths(oldStorage)
  await fs.mkdir(path.dirname(oldPaths.python), { recursive: true })
  await fs.writeFile(oldPaths.python, 'fixture python')
  await fs.writeFile(
    oldPaths.configuration,
    `home = ${path.join(oldStorage, 'runtimes', 'python', 'cpython-fixture')}\n`,
  )
  await fs.writeFile(oldPaths.marker, `${JSON.stringify({
    bundleId: CUDA_RUNTIME_BUNDLE,
    projectDigest: await digest(projectRoot),
    storageRoot: oldStorage,
    cudaVerified: true,
    flashAttentionVerified: true,
    muscriptorVerified: true,
  })}\n`)
  await fs.mkdir(path.dirname(newStorage), { recursive: true })
  await fs.rename(oldStorage, newStorage)

  const installer = new CudaRuntimeInstaller({
    storageRoot: newStorage,
    projectRoot,
    platform: 'win32',
    arch: 'x64',
  })
  assert.equal((await installer.status()).installed, true)
  assert.equal((await installer.status()).muscriptorInstalled, true)
  assert.match(await fs.readFile(runtimePaths(newStorage).configuration, 'utf8'), new RegExp(newStorage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(JSON.parse(await fs.readFile(runtimePaths(newStorage).marker)).storageRoot, path.resolve(newStorage))
})

test('does not offer the CUDA runtime on CPU-only packaged platforms', async () => {
  const resourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeseq-cuda-unsupported-'))
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeseq-cuda-storage-'))
  const { projectRoot } = await fixtureProject(resourceRoot)
  const installer = new CudaRuntimeInstaller({
    storageRoot,
    projectRoot,
    platform: 'linux',
    arch: 'x64',
  })
  assert.equal((await installer.status()).supported, false)
  await assert.rejects(() => installer.install({}), /only for Windows x64/)
})

test('repairs an incomplete FlashAttention metadata cache with a no-cache retry', async () => {
  const resourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeseq-cuda-repair-resource-'))
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeseq-cuda-repair-storage-'))
  const { projectRoot } = await fixtureProject(resourceRoot)
  const paths = runtimePaths(storageRoot)
  await fs.mkdir(path.dirname(paths.uv), { recursive: true })
  await fs.writeFile(paths.uv, 'fixture executable')
  const commands = []
  let syncAttempts = 0
  const runImpl = async (options) => {
    commands.push(options)
    if (options.args[0] !== 'sync') return ''
    syncAttempts += 1
    if (syncAttempts === 1) {
      throw new Error(
        'Failed to generate package metadata for flash-attn: '
        + 'failed to open cache/uv/archive-v0/broken/flash_attn-2.8.3.dist-info/METADATA',
      )
    }
    await fs.mkdir(path.dirname(paths.python), { recursive: true })
    await fs.writeFile(paths.python, 'fixture python')
    await fs.writeFile(paths.configuration, 'home = fixture\n')
    return ''
  }
  const installer = new CudaRuntimeInstaller({
    storageRoot,
    projectRoot,
    platform: 'win32',
    arch: 'x64',
    runImpl,
  })

  const installed = await installer.install({})

  assert.equal(installed.installed, true)
  assert.equal(syncAttempts, 2)
  assert.deepEqual(commands[0].args, ['cache', 'clean', 'flash-attn'])
  assert.equal(commands[1].args.includes('--no-cache'), false)
  assert.equal(commands[2].args.includes('--no-cache'), true)
})

test('MuScriptor installs and verifies independently from Stable Audio and FlashAttention', async () => {
  const resourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeseq-muscriptor-cuda-resource-'))
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeseq-muscriptor-cuda-storage-'))
  const { projectRoot } = await fixtureProject(resourceRoot)
  const paths = runtimePaths(storageRoot)
  await fs.mkdir(path.dirname(paths.uv), { recursive: true })
  await fs.writeFile(paths.uv, 'fixture executable')
  const commands = []
  const runImpl = async (options) => {
    commands.push(options)
    if (options.args[0] === 'sync') {
      await fs.mkdir(path.dirname(paths.python), { recursive: true })
      await fs.writeFile(paths.python, 'fixture python')
      await fs.writeFile(paths.configuration, 'home = fixture\n')
    }
    return ''
  }
  const installer = new CudaRuntimeInstaller({
    storageRoot,
    projectRoot,
    platform: 'win32',
    arch: 'x64',
    runImpl,
  })

  const installed = await installer.install({ profile: 'muscriptor' })

  assert.equal(installed.installed, true)
  assert.equal(installed.flashAttentionInstalled, false)
  assert.equal(installed.muscriptorInstalled, true)
  assert.deepEqual(commands[0].args, [
    'sync', '--project', projectRoot, '--locked', '--python', '3.12.10',
    '--extra', 'muscriptor', '--inexact',
    '--refresh-package', 'muscriptor', '--reinstall-package', 'muscriptor',
  ])
  assert.match(commands[2].args[1], /TranscriptionModel/)
  assert.doesNotMatch(commands[2].args[1], /flash_attn_func/)
  assert.doesNotMatch(commands[2].args[1], /StableAudioModel/)
  const marker = JSON.parse(await fs.readFile(paths.marker, 'utf8'))
  assert.equal(marker.cudaVerified, true)
  assert.equal(marker.flashAttentionVerified, false)
  assert.equal(marker.muscriptorVerified, true)
})

test('installing the second CUDA profile preserves the first profile verification', async () => {
  const resourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeseq-profile-resource-'))
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeseq-profile-storage-'))
  const { projectRoot } = await fixtureProject(resourceRoot)
  const paths = runtimePaths(storageRoot)
  await fs.mkdir(path.dirname(paths.uv), { recursive: true })
  await fs.writeFile(paths.uv, 'fixture executable')
  const runImpl = async (options) => {
    if (options.args[0] === 'sync') {
      await fs.mkdir(path.dirname(paths.python), { recursive: true })
      await fs.writeFile(paths.python, 'fixture python')
      await fs.writeFile(paths.configuration, 'home = fixture\n')
    }
    return ''
  }
  const installer = new CudaRuntimeInstaller({
    storageRoot,
    projectRoot,
    platform: 'win32',
    arch: 'x64',
    runImpl,
  })

  await installer.install({ profile: 'muscriptor' })
  const installed = await installer.install({ profile: 'stable-audio' })

  assert.equal(installed.installed, true)
  assert.equal(installed.flashAttentionInstalled, true)
  assert.equal(installed.muscriptorInstalled, true)
  const marker = JSON.parse(await fs.readFile(paths.marker, 'utf8'))
  assert.equal(marker.flashAttentionVerified, true)
  assert.equal(marker.muscriptorVerified, true)
})
