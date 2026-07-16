const { app, BrowserWindow, dialog, session } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const {
  configureElectronStorage,
  resolveStorageRoot,
  sidecarStorageEnvironment,
} = require('./storage-root.cjs')

const LOOPBACK_HOST = '127.0.0.1'
const STARTUP_TIMEOUT_MS = 30_000

let mainWindow = null
let sidecar = null
let sidecarLog = null
let quitting = false

const storageRoot = resolveStorageRoot({ isPackaged: app.isPackaged })
configureElectronStorage(app, storageRoot)

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const reservePort = () => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.unref()
  server.once('error', reject)
  server.listen(0, LOOPBACK_HOST, () => {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : null
    server.close((error) => {
      if (error) reject(error)
      else if (port === null) reject(new Error('Could not reserve a loopback port.'))
      else resolve(port)
    })
  })
})

const packagedResource = (name) => path.join(process.resourcesPath, name)

const sidecarExecutable = () => {
  const executable = process.platform === 'win32' ? 'vibeseq-inference.exe' : 'vibeseq-inference'
  if (app.isPackaged) return packagedResource(path.join('server', executable))
  return path.join(__dirname, '..', 'desktop-out', 'sidecar', 'vibeseq-inference', executable)
}

const studioDirectory = () => (
  app.isPackaged ? packagedResource('studio') : path.join(__dirname, '..', 'dist')
)

const appendDesktopLog = (message) => {
  if (sidecarLog) sidecarLog.write(`[desktop] ${message}\n`)
}

const stopSidecar = () => {
  if (!sidecar || sidecar.killed) return
  sidecar.kill()
  sidecar = null
}

const waitForStudio = async (origin, processHandle) => {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  let lastError = null
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`The local inference service exited with code ${processHandle.exitCode}.`)
    }
    try {
      const health = await fetch(`${origin}/api/health`)
      if (health.ok) return
      lastError = new Error(`Health check returned ${health.status}.`)
    } catch (error) {
      lastError = error
    }
    await delay(200)
  }
  throw new Error(`Timed out starting the local service: ${lastError?.message ?? 'unknown error'}`)
}

const launchSidecar = async () => {
  const port = await reservePort()
  const origin = `http://${LOOPBACK_HOST}:${port}`
  const executable = sidecarExecutable()
  const studio = studioDirectory()

  if (!fs.existsSync(executable)) throw new Error(`Missing desktop sidecar: ${executable}`)
  if (!fs.existsSync(path.join(studio, 'index.html'))) throw new Error(`Missing Studio build: ${studio}`)

  fs.mkdirSync(app.getPath('logs'), { recursive: true })
  sidecarLog = fs.createWriteStream(path.join(app.getPath('logs'), 'vibeseq-desktop.log'), { flags: 'a' })
  appendDesktopLog(`starting ${app.getVersion()} on ${process.platform}/${process.arch}`)
  appendDesktopLog('using data-root model cache')

  sidecar = spawn(executable, [], {
    env: {
      ...process.env,
      VIBESEQ_HOST: LOOPBACK_HOST,
      VIBESEQ_PORT: String(port),
      VIBESEQ_STUDIO_DIST: studio,
      VIBESEQ_TARGET: 'local',
      VIBESEQ_GENERATION_PROVIDER: process.env.VIBESEQ_GENERATION_PROVIDER || 'stable-audio-3',
      VIBESEQ_TRANSCRIPTION_PROVIDER: process.env.VIBESEQ_TRANSCRIPTION_PROVIDER || 'muscriptor',
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
    if (!quitting && mainWindow && !mainWindow.isDestroyed()) {
      void dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'VibeSeq engine stopped',
        message: 'The local VibeSeq engine stopped unexpectedly.',
        detail: `Exit code: ${code ?? 'unknown'}. Restart VibeSeq to continue.`,
      })
    }
  })

  await waitForStudio(origin, sidecar)
  return origin
}

const createWindow = async (origin) => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))

  mainWindow = new BrowserWindow({
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
      sandbox: true,
      webSecurity: true,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault()
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })
  await mainWindow.loadURL(origin)
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.whenReady().then(async () => {
  try {
    const origin = await launchSidecar()
    await createWindow(origin)
  } catch (error) {
    appendDesktopLog(`startup failure: ${error.stack ?? error.message}`)
    await dialog.showMessageBox({
      type: 'error',
      title: 'VibeSeq could not start',
      message: 'VibeSeq could not start its local engine.',
      detail: `${error.message}\n\nLog: ${path.join(app.getPath('logs'), 'vibeseq-desktop.log')}`,
    })
    app.quit()
  }
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  quitting = true
  stopSidecar()
  sidecarLog?.end()
})
