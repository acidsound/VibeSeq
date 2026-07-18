const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const {
  LOOPBACK_HOST,
  findAvailablePort,
} = require('./port-selection.cjs')
const {
  configureElectronStorage,
  prepareStorageRootAsync,
  resolveStorageRoot,
  sidecarStorageEnvironment,
} = require('./storage-root.cjs')
const { runDesktopStartup } = require('./startup-flow.cjs')
const { terminateProcessTree } = require('./process-tree.cjs')
const { StableAudioModelInstaller } = require('./model-installer.cjs')
const {
  CudaRuntimeInstaller,
  runtimeProjectDigest,
} = require('./cuda-runtime-installer.cjs')
const stableAudioManifest = require('./stable-audio-model-bundle.json')
const stableAudioGpuManifest = require('./stable-audio-gpu-model-bundle.json')
const { MuscriptorCacheVerifier } = require('./muscriptor-importer.cjs')
const muscriptorManifest = require('./muscriptor-model-bundle.json')

const ELECTRON_SERVER_START_PORT = 10_000
const STARTUP_TIMEOUT_MS = process.platform === 'win32' ? 120_000 : 60_000
const RENDERER_READY_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 30_000

let mainWindow = null
let startupWindow = null
let sidecar = null
let sidecarLog = null
let quitting = false
let modelInstallController = null
let modelInstallPromise = null
let cudaRuntimeInstallController = null
let cudaRuntimeInstallPromise = null
let studioOrigin = null
let startupState = {
  phase: 'window',
  step: 0,
  title: 'Opening VibeSeq',
  detail: 'Preparing the startup window.',
  elapsedSeconds: 0,
}

const storageRoot = resolveStorageRoot({ isPackaged: app.isPackaged })
configureElectronStorage(app, storageRoot)

const stableAudioInstaller = new StableAudioModelInstaller({
  storageRoot,
  manifest: stableAudioManifest,
})
const stableAudioGpuInstaller = new StableAudioModelInstaller({
  storageRoot,
  manifest: stableAudioGpuManifest,
})
const stableAudioInstallerFor = (modelId) => (
  modelId === stableAudioGpuManifest.modelId
    ? stableAudioGpuInstaller
    : stableAudioInstaller
)
const cudaRuntimeProjectRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'cuda-runtime', 'desktop', 'cuda-runtime')
  : path.join(__dirname, 'cuda-runtime')
const cudaRuntimeInstaller = new CudaRuntimeInstaller({
  storageRoot,
  projectRoot: cudaRuntimeProjectRoot,
})
const muscriptorCacheVerifier = new MuscriptorCacheVerifier({
  storageRoot,
  manifest: muscriptorManifest,
})

const updateStartup = (update) => {
  startupState = { ...startupState, ...update }
  if (startupWindow && !startupWindow.isDestroyed()) {
    startupWindow.webContents.send('desktop:startup-progress', startupState)
  }
}

const installCudaRuntime = ({ signal, requireFlashAttention, onProgress }) => {
  const previous = cudaRuntimeInstallPromise || Promise.resolve()
  const current = previous.catch(() => undefined).then(() => cudaRuntimeInstaller.install({
    signal,
    requireFlashAttention,
    onProgress,
  }))
  const queued = current.finally(() => {
    if (cudaRuntimeInstallPromise === queued) cudaRuntimeInstallPromise = null
  })
  cudaRuntimeInstallPromise = queued
  return queued
}

ipcMain.handle('desktop:startup-state', () => startupState)
ipcMain.handle('stable-audio:status', async (_event, request) => {
  const status = await stableAudioInstallerFor(request?.modelId).status()
  if (request?.modelId !== stableAudioGpuManifest.modelId) return status
  const runtime = await cudaRuntimeInstaller.status()
  return {
    ...status,
    modelInstalled: status.installed,
    runtimeInstalled: runtime.flashAttentionInstalled,
    installed: status.installed && runtime.flashAttentionInstalled,
  }
})
ipcMain.handle('stable-audio:install', async (_event, request) => {
  if (request?.accepted !== true) {
    throw new Error('Accept the Stable Audio and Gemma terms before downloading the model.')
  }
  if (modelInstallPromise) return modelInstallPromise
  const installer = stableAudioInstallerFor(request?.modelId)
  modelInstallController = new AbortController()
  const sendInstallProgress = (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('stable-audio:progress', progress)
    }
  }
  modelInstallPromise = (async () => {
    if (request?.modelId === stableAudioGpuManifest.modelId) {
      const modelStatus = await installer.status()
      await installCudaRuntime({
        signal: modelInstallController.signal,
        requireFlashAttention: true,
        onProgress: (detail) => sendInstallProgress({
          phase: 'runtime',
          asset: detail,
          downloadedBytes: 0,
          totalBytes: modelStatus.totalBytes,
        }),
      })
    }
    const installed = await installer.install({
      accepted: true,
      signal: modelInstallController.signal,
      onProgress: sendInstallProgress,
    })
    if (request?.modelId !== stableAudioGpuManifest.modelId) return installed
    return {
      ...installed,
      modelInstalled: installed.installed,
      runtimeInstalled: true,
    }
  })().finally(() => {
    modelInstallController = null
    modelInstallPromise = null
  })
  return modelInstallPromise
})
ipcMain.handle('stable-audio:cancel', () => {
  modelInstallController?.abort()
  return { cancelled: Boolean(modelInstallController) }
})
ipcMain.handle('cuda-runtime:status', () => cudaRuntimeInstaller.status())
ipcMain.handle('cuda-runtime:install', () => {
  if (cudaRuntimeInstallController) return cudaRuntimeInstallPromise
  cudaRuntimeInstallController = new AbortController()
  const sendProgress = (detail) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('cuda-runtime:progress', { detail })
    }
  }
  const promise = installCudaRuntime({
    signal: cudaRuntimeInstallController.signal,
    requireFlashAttention: false,
    onProgress: sendProgress,
  }).finally(() => {
    cudaRuntimeInstallController = null
  })
  return promise
})
ipcMain.handle('cuda-runtime:cancel', () => {
  cudaRuntimeInstallController?.abort()
  return { cancelled: Boolean(cudaRuntimeInstallController) }
})
ipcMain.handle('muscriptor:verify-cache', () => muscriptorCacheVerifier.verify())
ipcMain.handle('muscriptor:open-cache', async () => {
  const modelCache = await muscriptorCacheVerifier.ensureCacheDirectory()
  const error = await shell.openPath(modelCache)
  if (error) throw new Error(`Could not open the MuScriptor cache folder: ${error}`)
  return { path: modelCache }
})
ipcMain.handle('desktop:open-model-cache', async () => {
  const modelCache = path.join(storageRoot, 'models', 'huggingface', 'hub')
  fs.mkdirSync(modelCache, { recursive: true })
  const error = await shell.openPath(modelCache)
  if (error) throw new Error(`Could not open the model cache folder: ${error}`)
  return { path: modelCache }
})
ipcMain.handle('desktop:open-external', async (_event, value) => {
  const url = new URL(String(value))
  const allowedHosts = new Set(['ai.google.dev', 'github.com', 'huggingface.co', 'stability.ai'])
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) {
    throw new Error('VibeSeq refused to open an untrusted external URL.')
  }
  await shell.openExternal(url.toString())
})

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const packagedResource = (name) => path.join(process.resourcesPath, name)

const sidecarExecutable = () => {
  const executable = process.platform === 'win32' ? 'vibeseq-inference.exe' : 'vibeseq-inference'
  if (app.isPackaged) return packagedResource(path.join('server', executable))
  return path.join(__dirname, '..', 'desktop-out', 'sidecar', 'vibeseq-inference', executable)
}

const studioDirectory = () => (
  app.isPackaged ? packagedResource('studio') : path.join(__dirname, '..', 'dist')
)

const startupPageUrl = pathToFileURL(path.join(__dirname, 'startup.html')).toString()

const appendDesktopLog = (message) => {
  if (sidecarLog) sidecarLog.write(`[desktop] ${message}\n`)
}

const activeWindow = () => {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) return mainWindow
  if (startupWindow && !startupWindow.isDestroyed()) return startupWindow
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  return null
}

const stopSidecar = () => {
  if (!sidecar) return
  terminateProcessTree(sidecar)
  sidecar = null
}

const waitForStudio = async (origin, processHandle, onProgress) => {
  const startedAt = Date.now()
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  let lastError = null
  let processError = null
  let lastReportedSecond = -1
  const recordProcessError = (error) => { processError = error }
  processHandle.once('error', recordProcessError)

  try {
    while (Date.now() < deadline) {
      if (processError) throw processError
      if (processHandle.exitCode !== null) {
        throw new Error(`The local inference service exited with code ${processHandle.exitCode}.`)
      }

      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000)
      if (elapsedSeconds !== lastReportedSecond) {
        lastReportedSecond = elapsedSeconds
        onProgress({
          phase: 'health',
          step: 3,
          title: 'Waiting for the local engine',
          detail: 'Loading audio and MIDI runtimes, then checking the local API.',
          elapsedSeconds,
        })
      }

      try {
        const health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_500) })
        if (health.ok) return
        lastError = new Error(`Health check returned ${health.status}.`)
      } catch (error) {
        lastError = error
      }
      await delay(250)
    }
  } finally {
    processHandle.removeListener('error', recordProcessError)
  }
  throw new Error(`Timed out starting the local service: ${lastError?.message ?? 'unknown error'}`)
}

const launchSidecar = async (onProgress) => {
  onProgress({
    phase: 'engine',
    step: 2,
    title: 'Starting the local engine',
    detail: 'Selecting a private local port and checking the bundled engine files.',
    elapsedSeconds: 0,
  })
  const port = await findAvailablePort(ELECTRON_SERVER_START_PORT)
  const origin = `http://${LOOPBACK_HOST}:${port}`
  const executable = sidecarExecutable()
  const studio = studioDirectory()
  const cudaProjectDigest = await runtimeProjectDigest(cudaRuntimeProjectRoot)
  await cudaRuntimeInstaller.status()

  if (!fs.existsSync(executable)) throw new Error(`Missing desktop sidecar: ${executable}`)
  if (!fs.existsSync(path.join(studio, 'index.html'))) throw new Error(`Missing Studio build: ${studio}`)

  fs.mkdirSync(app.getPath('logs'), { recursive: true })
  sidecarLog = fs.createWriteStream(path.join(app.getPath('logs'), 'vibeseq-desktop.log'), { flags: 'a' })
  appendDesktopLog(`starting ${app.getVersion()} on ${process.platform}/${process.arch}`)
  appendDesktopLog('using data-root model cache')
  appendDesktopLog(`using local Studio/API origin ${origin}`)

  sidecar = spawn(executable, [], {
    env: {
      ...process.env,
      VIBESEQ_HOST: LOOPBACK_HOST,
      VIBESEQ_PORT: String(port),
      VIBESEQ_STUDIO_DIST: studio,
      VIBESEQ_TARGET: 'local',
      VIBESEQ_GENERATION_PROVIDER: process.env.VIBESEQ_GENERATION_PROVIDER || 'stable-audio-3',
      VIBESEQ_TRANSCRIPTION_PROVIDER: process.env.VIBESEQ_TRANSCRIPTION_PROVIDER || 'muscriptor',
      VIBESEQ_CUDA_RUNTIME_PROJECT_DIGEST: cudaProjectDigest,
      ...sidecarStorageEnvironment(storageRoot),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  sidecar.stdout?.pipe(sidecarLog, { end: false })
  sidecar.stderr?.pipe(sidecarLog, { end: false })
  sidecar.once('error', (error) => appendDesktopLog(`sidecar error: ${error.message}`))
  sidecar.once('exit', (code, signal) => {
    appendDesktopLog(`sidecar exit code=${code} signal=${signal}`)
    const owner = activeWindow()
    if (!quitting && owner) {
      void dialog.showMessageBox(owner, {
        type: 'error',
        title: 'VibeSeq engine stopped',
        message: 'The local VibeSeq engine stopped unexpectedly.',
        detail: `Exit code: ${code ?? 'unknown'}. Restart VibeSeq to continue.`,
      })
    }
  })

  await waitForStudio(origin, sidecar, onProgress)
  return origin
}

const isAllowedNavigation = (url) => {
  if (url === startupPageUrl) return true
  if (!studioOrigin) return false
  try {
    return new URL(url).origin === studioOrigin
  } catch {
    return false
  }
}

const createWindow = async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))

  startupWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#111315',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      webSecurity: true,
    },
  })

  startupWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  startupWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault()
  })
  startupWindow.on('closed', () => {
    startupWindow = null
    if (!quitting && (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible())) app.quit()
  })
  await startupWindow.loadFile(path.join(__dirname, 'startup.html'))
  startupWindow.show()
}

const logRendererEvents = (window) => {
  const { webContents } = window
  webContents.on('console-message', (details) => {
    appendDesktopLog(
      `renderer console ${details.level}: ${details.message} (${details.sourceId || 'unknown'}:${details.lineNumber || 0})`,
    )
  })
  webContents.on('dom-ready', () => appendDesktopLog('renderer DOM ready'))
  webContents.on('did-finish-load', () => appendDesktopLog(`renderer finished loading ${webContents.getURL()}`))
  webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    appendDesktopLog(
      `renderer load failed code=${errorCode} main-frame=${isMainFrame} url=${validatedURL} error=${errorDescription}`,
    )
  })
  webContents.on('preload-error', (_event, preloadPath, error) => {
    appendDesktopLog(`renderer preload failed path=${preloadPath} error=${error.stack ?? error.message}`)
  })
  webContents.on('render-process-gone', (_event, details) => {
    appendDesktopLog(`renderer process gone reason=${details.reason} exit-code=${details.exitCode}`)
  })
  window.on('unresponsive', () => appendDesktopLog('renderer became unresponsive'))
  window.on('responsive', () => appendDesktopLog('renderer became responsive'))
}

const waitForStudioRenderer = (window, origin, onProgress) => new Promise((resolve, reject) => {
  const startedAt = Date.now()
  let settled = false
  let lastReportedSecond = -1

  const cleanup = () => {
    clearTimeout(timeout)
    clearInterval(progressTimer)
    ipcMain.removeListener('desktop:studio-ready', handleReady)
    window.webContents.removeListener('did-fail-load', handleLoadFailure)
    window.webContents.removeListener('preload-error', handlePreloadFailure)
    window.webContents.removeListener('render-process-gone', handleRendererGone)
    window.removeListener('unresponsive', handleUnresponsive)
  }
  const finish = (error) => {
    if (settled) return
    settled = true
    cleanup()
    if (error) reject(error)
    else resolve()
  }
  const handleReady = (event) => {
    if (event.sender !== window.webContents) return
    appendDesktopLog(`renderer reported Studio ready after ${Date.now() - startedAt}ms`)
    finish()
  }
  const handleLoadFailure = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    finish(new Error(`Studio failed to load (${errorCode}): ${errorDescription} · ${validatedURL}`))
  }
  const handlePreloadFailure = (_event, preloadPath, error) => {
    finish(new Error(`Studio preload failed at ${preloadPath}: ${error.message}`))
  }
  const handleRendererGone = (_event, details) => {
    finish(new Error(`Studio renderer stopped (${details.reason}, exit ${details.exitCode}).`))
  }
  const handleUnresponsive = () => {
    finish(new Error('Studio renderer became unresponsive before the interface was ready.'))
  }
  const reportProgress = () => {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000)
    if (elapsedSeconds === lastReportedSecond) return
    lastReportedSecond = elapsedSeconds
    onProgress({
      phase: 'studio',
      step: 4,
      title: 'Opening Studio',
      detail: 'The local engine is ready. Waiting for the interface to render.',
      elapsedSeconds,
    })
  }

  ipcMain.on('desktop:studio-ready', handleReady)
  window.webContents.on('did-fail-load', handleLoadFailure)
  window.webContents.once('preload-error', handlePreloadFailure)
  window.webContents.once('render-process-gone', handleRendererGone)
  window.once('unresponsive', handleUnresponsive)
  const timeout = setTimeout(() => {
    finish(new Error(`Studio did not render within ${Math.round(RENDERER_READY_TIMEOUT_MS / 1000)} seconds.`))
  }, RENDERER_READY_TIMEOUT_MS)
  const progressTimer = setInterval(reportProgress, 500)
  reportProgress()

  void window.loadURL(origin).catch((error) => finish(error))
})

const loadStudio = async (origin, onProgress) => {
  studioOrigin = origin
  const window = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#111315',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      webSecurity: true,
    },
  })
  mainWindow = window
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault()
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  logRendererEvents(window)

  try {
    await waitForStudioRenderer(window, origin, onProgress)
    if (window.isDestroyed()) throw new Error('Studio window closed before the interface was ready.')
    window.show()
    startupWindow?.destroy()
    startupWindow = null
  } catch (error) {
    if (!window.isDestroyed()) window.destroy()
    if (mainWindow === window) mainWindow = null
    throw error
  }
}

const hasSingleInstanceLock = !app.isPackaged || app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

app.on('second-instance', () => {
  const window = activeWindow()
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.focus()
})

app.whenReady().then(async () => {
  try {
    await runDesktopStartup({
      createWindow,
      prepareStorage: () => prepareStorageRootAsync(storageRoot),
      launchSidecar,
      loadStudio,
      updateStartup,
    })
  } catch (error) {
    updateStartup({
      phase: 'error',
      title: 'VibeSeq could not start',
      detail: error.message,
    })
    appendDesktopLog(`startup failure: ${error.stack ?? error.message}`)
    const options = {
      type: 'error',
      title: 'VibeSeq could not start',
      message: 'VibeSeq could not start its local engine.',
      detail: `${error.message}\n\nLog: ${path.join(app.getPath('logs'), 'vibeseq-desktop.log')}`,
    }
    const owner = activeWindow()
    if (owner) {
      await dialog.showMessageBox(owner, options)
    } else {
      await dialog.showMessageBox(options)
    }
    app.quit()
  }
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  quitting = true
  modelInstallController?.abort()
  cudaRuntimeInstallController?.abort()
  stopSidecar()
  sidecarLog?.end()
})
