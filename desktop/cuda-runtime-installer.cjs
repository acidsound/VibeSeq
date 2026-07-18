const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { unzipSync } = require('fflate')

const CUDA_RUNTIME_BUNDLE = 'windows-cuda-fa2-py312-torch271-cu126-fa283-v1'
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
  const abort = () => child.kill()
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
    const installed = Boolean(
      marker?.bundleId === CUDA_RUNTIME_BUNDLE
      && marker?.projectDigest === projectDigest
      && fs.existsSync(paths.python)
      && fs.existsSync(paths.configuration),
    )
    return {
      supported: this.platform === 'win32' && this.arch === 'x64',
      installed,
      bundleId: CUDA_RUNTIME_BUNDLE,
      runtimeRoot: paths.root,
      python: installed ? paths.python : null,
    }
  }

  async install({ signal, onProgress = () => {} }) {
    const before = await this.status()
    if (!before.supported) throw new Error('The CUDA/FlashAttention runtime is packaged only for Windows x64.')
    if (before.installed) return before
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
    onProgress('Installing isolated Python, CUDA PyTorch, and FlashAttention 2')
    await this.run({
      command: paths.uv,
      args: ['sync', '--project', this.projectRoot, '--locked', '--python', '3.12.10'],
      cwd: this.projectRoot,
      env: environment,
      signal,
      onLine: onProgress,
    })

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

    onProgress('Running a FlashAttention 2 kernel on the detected NVIDIA GPU')
    const smoke = [
      'import torch',
      'import flash_attn',
      'import sentencepiece',
      'from flash_attn import flash_attn_func',
      'from stable_audio_3 import StableAudioModel',
      'from vibeseq_inference.stable_audio_cuda_worker import main as worker_main',
      "assert torch.__version__ == '2.7.1+cu126', torch.__version__",
      "assert torch.version.cuda == '12.6', torch.version.cuda",
      "assert flash_attn.__version__.startswith('2.8.3'), flash_attn.__version__",
      'assert callable(StableAudioModel.from_pretrained)',
      'assert callable(worker_main)',
      'assert torch.cuda.is_available()',
      'major, _ = torch.cuda.get_device_capability(0)',
      'assert major >= 8',
      "q = torch.randn((1, 128, 4, 64), device='cuda', dtype=torch.float16)",
      'out = flash_attn_func(q, q, q, causal=False)',
      'torch.cuda.synchronize()',
      'assert out.shape == q.shape',
    ].join('; ')
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
