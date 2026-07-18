const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { unzipSync } = require('fflate')
const { terminateProcessTree } = require('./process-tree.cjs')

const CUDA_RUNTIME_BUNDLE = 'windows-cuda-fa2-py312-torch271-cu126-fa283-v1'
const FLASH_ATTENTION_PACKAGE = 'flash-attn'
const UV_VERSION = '0.11.1'
const UV_URL = 'https://github.com/astral-sh/uv/releases/download/0.11.1/uv-x86_64-pc-windows-msvc.zip'
const UV_SHA256 = '6659250cebbd3bb6ee48bcb21a3f0c6656450d63fb97f0f069bcb532bdb688ed'

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')

const walkFiles = async (root) => {
  const entries = await fsp.readdir(root, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const filename = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...await walkFiles(filename))
    else if (entry.isFile()) files.push(filename)
  }
  return files
}

const runtimeProjectDigest = async (projectRoot) => {
  const resourceRoot = path.resolve(projectRoot, '..', '..')
  const serverRoot = path.join(resourceRoot, 'server')
  const files = [
    path.join(projectRoot, 'pyproject.toml'),
    path.join(projectRoot, 'uv.lock'),
    path.join(serverRoot, 'pyproject.toml'),
    ...await walkFiles(path.join(serverRoot, 'vibeseq_inference')),
  ]
  const hash = crypto.createHash('sha256')
  for (const filename of files) {
    hash.update(path.relative(resourceRoot, filename).replaceAll(path.sep, '/'))
    hash.update('\0')
    hash.update(await fsp.readFile(filename))
    hash.update('\0')
  }
  return hash.digest('hex')
}

const runtimePaths = (storageRoot) => {
  const root = path.join(storageRoot, 'runtimes', CUDA_RUNTIME_BUNDLE)
  return {
    root,
    environment: path.join(root, 'venv'),
    python: path.join(root, 'venv', 'Scripts', 'python.exe'),
    configuration: path.join(root, 'venv', 'pyvenv.cfg'),
    marker: path.join(root, '.vibeseq-runtime.json'),
    uv: path.join(storageRoot, 'runtimes', 'tools', `uv-${UV_VERSION}`, 'uv.exe'),
    uvArchive: path.join(storageRoot, 'runtimes', 'tools', `uv-${UV_VERSION}.zip`),
  }
}

const readMarker = async (filename) => {
  try {
    return JSON.parse(await fsp.readFile(filename, 'utf8'))
  } catch {
    return null
  }
}

const isFlashAttentionCacheMetadataError = (error) => {
  const message = String(error?.message || error).toLowerCase()
  return message.includes(FLASH_ATTENTION_PACKAGE)
    && message.includes('metadata')
    && (message.includes('archive-v') || message.includes('cache'))
}

const run = ({ command, args, cwd, env, signal, onLine = () => {} }) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const handle = (chunk) => {
    const text = chunk.toString()
    output = `${output}${text}`.slice(-8000)
    for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line.trim())
  }
  child.stdout.on('data', handle)
  child.stderr.on('data', handle)
  const abort = () => terminateProcessTree(child)
  signal?.addEventListener('abort', abort, { once: true })
  child.once('error', reject)
  child.once('exit', (code) => {
    signal?.removeEventListener('abort', abort)
    if (signal?.aborted) {
      reject(new DOMException('Installation cancelled.', 'AbortError'))
    } else if (code === 0) {
      resolve(output)
    } else {
      reject(new Error(`CUDA runtime command failed with exit code ${code}: ${output}`))
    }
  })
})

class CudaRuntimeInstaller {
  constructor({
    storageRoot,
    projectRoot,
    platform = process.platform,
    arch = process.arch,
    fetchImpl = globalThis.fetch,
    runImpl = run,
  }) {
    this.storageRoot = storageRoot
    this.projectRoot = projectRoot
    this.platform = platform
    this.arch = arch
    this.fetch = fetchImpl
    this.run = runImpl
  }

  async status() {
    const paths = runtimePaths(this.storageRoot)
    let marker = await readMarker(paths.marker)
    if (
      marker?.storageRoot
      && path.resolve(marker.storageRoot).toLowerCase() !== path.resolve(this.storageRoot).toLowerCase()
      && fs.existsSync(paths.configuration)
    ) {
      const previousRoot = String(marker.storageRoot)
      const currentRoot = path.resolve(this.storageRoot)
      const configuration = await fsp.readFile(paths.configuration, 'utf8')
      const relocated = configuration
        .split(previousRoot).join(currentRoot)
        .split(previousRoot.replaceAll('\\', '/')).join(currentRoot.replaceAll('\\', '/'))
      const temporaryConfiguration = `${paths.configuration}.tmp`
      await fsp.writeFile(temporaryConfiguration, relocated, 'utf8')
      await fsp.rename(temporaryConfiguration, paths.configuration)
      marker = {
        ...marker,
        storageRoot: currentRoot,
        relocatedAt: new Date().toISOString(),
      }
      const temporaryMarker = `${paths.marker}.tmp`
      await fsp.writeFile(temporaryMarker, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
      await fsp.rename(temporaryMarker, paths.marker)
    }
    let projectDigest = null
    try {
      projectDigest = await runtimeProjectDigest(this.projectRoot)
    } catch {
      // Missing packaged project resources invalidate an older environment.
    }
    const projectInstalled = Boolean(
      marker?.bundleId === CUDA_RUNTIME_BUNDLE
      && marker?.projectDigest === projectDigest
      && fs.existsSync(paths.python)
      && fs.existsSync(paths.configuration),
    )
    const installed = projectInstalled && marker?.cudaVerified === true
    const flashAttentionInstalled = installed && marker?.flashAttentionVerified === true
    return {
      supported: this.platform === 'win32' && this.arch === 'x64',
      installed,
      flashAttentionInstalled,
      bundleId: CUDA_RUNTIME_BUNDLE,
      runtimeRoot: paths.root,
      python: installed ? paths.python : null,
    }
  }

  async install({ signal, onProgress = () => {}, requireFlashAttention = true }) {
    const before = await this.status()
    if (!before.supported) throw new Error('The CUDA/FlashAttention runtime is packaged only for Windows x64.')
    if (before.installed && (!requireFlashAttention || before.flashAttentionInstalled)) return before
    const paths = runtimePaths(this.storageRoot)
    await fsp.mkdir(path.dirname(paths.uv), { recursive: true })

    if (!fs.existsSync(paths.uv)) {
      onProgress('Downloading the isolated runtime installer')
      const response = await this.fetch(UV_URL, { redirect: 'follow', signal })
      if (!response.ok) throw new Error(`Could not download the isolated runtime installer: HTTP ${response.status}`)
      const archive = Buffer.from(await response.arrayBuffer())
      if (sha256(archive) !== UV_SHA256) throw new Error('The isolated runtime installer digest did not match.')
      await fsp.writeFile(paths.uvArchive, archive)
      const files = unzipSync(new Uint8Array(archive))
      const executable = files['uv.exe']
      if (!executable) throw new Error('The isolated runtime installer archive did not contain uv.exe.')
      await fsp.writeFile(paths.uv, executable)
    }

    await fsp.mkdir(paths.root, { recursive: true })
    const environment = {
      ...process.env,
      UV_PROJECT_ENVIRONMENT: paths.environment,
      UV_PYTHON_INSTALL_DIR: path.join(this.storageRoot, 'runtimes', 'python'),
      UV_CACHE_DIR: path.join(this.storageRoot, 'cache', 'uv'),
      UV_LINK_MODE: 'copy',
      UV_NO_PROGRESS: '1',
    }

    // A cancelled or interrupted first install can leave uv's extracted direct
    // wheel entry without its dist-info/METADATA file. Since environments use
    // copy mode, clearing only this package cache cannot damage an installed
    // runtime and avoids carrying the broken entry into the next attempt.
    let useTemporaryCache = false
    onProgress('Refreshing the pinned FlashAttention wheel cache')
    try {
      await this.run({
        command: paths.uv,
        args: ['cache', 'clean', FLASH_ATTENTION_PACKAGE],
        cwd: this.projectRoot,
        env: environment,
        signal,
        onLine: onProgress,
      })
    } catch {
      useTemporaryCache = true
      onProgress('The shared package cache is unavailable; using a temporary cache')
    }

    const syncArgs = [
      'sync',
      '--project',
      this.projectRoot,
      '--locked',
      '--python',
      '3.12.10',
      '--refresh-package',
      FLASH_ATTENTION_PACKAGE,
      '--reinstall-package',
      FLASH_ATTENTION_PACKAGE,
    ]
    if (useTemporaryCache) syncArgs.push('--no-cache')
    onProgress('Installing isolated Python and CUDA PyTorch runtime')
    try {
      await this.run({
        command: paths.uv,
        args: syncArgs,
        cwd: this.projectRoot,
        env: environment,
        signal,
        onLine: onProgress,
      })
    } catch (error) {
      if (useTemporaryCache || !isFlashAttentionCacheMetadataError(error)) throw error
      onProgress('Retrying the FlashAttention wheel with an isolated temporary cache')
      await this.run({
        command: paths.uv,
        args: [...syncArgs, '--no-cache'],
        cwd: this.projectRoot,
        env: environment,
        signal,
        onLine: onProgress,
      })
    }

    onProgress('Installing the release-matched VibeSeq CUDA worker')
    await this.run({
      command: paths.uv,
      args: [
        'pip',
        'install',
        '--python',
        paths.python,
        '--no-deps',
        '--no-build-isolation',
        '--reinstall',
        path.resolve(this.projectRoot, '..', '..', 'server'),
      ],
      cwd: this.projectRoot,
      env: environment,
      signal,
      onLine: onProgress,
    })

    onProgress(
      requireFlashAttention
        ? 'Running CUDA and FlashAttention 2 kernels on the detected NVIDIA GPU'
        : 'Running a CUDA kernel for MuScriptor on the detected NVIDIA GPU',
    )
    const smokeStatements = [
      'import torch',
      'import muscriptor',
      'from muscriptor import TranscriptionModel',
      'from vibeseq_inference.cuda_service import CudaModelManager',
      'from vibeseq_inference.muscriptor_cuda_worker import main as muscriptor_worker_main',
      "assert torch.__version__ == '2.7.1+cu126', torch.__version__",
      "assert torch.version.cuda == '12.6', torch.version.cuda",
      'assert callable(TranscriptionModel.load_model)',
      'assert callable(CudaModelManager.generate)',
      'assert callable(muscriptor_worker_main)',
      'assert torch.cuda.is_available()',
      "cuda_probe = torch.ones((32, 32), device='cuda', dtype=torch.float16)",
      'cuda_out = cuda_probe @ cuda_probe',
      'torch.cuda.synchronize()',
      'assert cuda_out.shape == cuda_probe.shape',
    ]
    if (requireFlashAttention) {
      smokeStatements.push(
        'import flash_attn',
        'import sentencepiece',
        'from flash_attn import flash_attn_func',
        'from stable_audio_3 import StableAudioModel',
        'from vibeseq_inference.stable_audio_cuda_worker import main as worker_main',
        "assert flash_attn.__version__.startswith('2.8.3'), flash_attn.__version__",
        'assert callable(StableAudioModel.from_pretrained)',
        'assert callable(worker_main)',
        'major, _ = torch.cuda.get_device_capability(0)',
        'assert major >= 8',
        "q = torch.randn((1, 128, 4, 64), device='cuda', dtype=torch.float16)",
        'out = flash_attn_func(q, q, q, causal=False)',
        'torch.cuda.synchronize()',
        'assert out.shape == q.shape',
      )
    }
    const smoke = smokeStatements.join('; ')
    await this.run({
      command: paths.python,
      args: ['-c', smoke],
      cwd: this.projectRoot,
      env: environment,
      signal,
      onLine: onProgress,
    })

    const marker = {
      schemaVersion: 1,
      bundleId: CUDA_RUNTIME_BUNDLE,
      projectDigest: await runtimeProjectDigest(this.projectRoot),
      storageRoot: path.resolve(this.storageRoot),
      python: '3.12.10',
      torch: '2.7.1+cu126',
      flashAttention: '2.8.3+cu126torch2.7',
      cudaVerified: true,
      flashAttentionVerified: requireFlashAttention || before.flashAttentionInstalled,
      verifiedAt: new Date().toISOString(),
    }
    const temporary = `${paths.marker}.tmp`
    await fsp.writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
    await fsp.rename(temporary, paths.marker)
    return this.status()
  }
}

module.exports = {
  CUDA_RUNTIME_BUNDLE,
  CudaRuntimeInstaller,
  runtimeProjectDigest,
  runtimePaths,
}
