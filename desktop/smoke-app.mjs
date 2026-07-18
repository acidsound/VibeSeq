import { _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const projectRoot = path.resolve(import.meta.dirname, '..')
const executableArgument = process.argv[2]
const executablePath = executableArgument ? path.resolve(projectRoot, executableArgument) : undefined
if (executablePath && !fs.existsSync(executablePath)) {
  throw new Error(`Packaged app executable not found: ${executablePath}`)
}
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeseq-app-smoke-'))
const launchOptions = {
  args: executablePath ? [] : [projectRoot],
  env: {
    ...process.env,
    VIBESEQ_HOME: path.join(smokeRoot, 'VibeSeq Data'),
  },
}
if (executablePath) {
  launchOptions.executablePath = executablePath
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const deadline = (milliseconds) => Date.now() + milliseconds

let application
try {
  application = await electron.launch(launchOptions)
  const startup = await application.firstWindow()
  await startup.waitForLoadState('domcontentloaded')
  if (await startup.title() !== 'Starting VibeSeq') {
    throw new Error(`Expected startup window first, received ${await startup.title()}`)
  }

  let studio = null
  const studioDeadline = deadline(process.platform === 'win32' ? 180_000 : 90_000)
  while (!studio && Date.now() < studioDeadline) {
    studio = application.windows().find((page) => page.url().startsWith('http://127.0.0.1:')) ?? null
    if (!studio) await delay(100)
  }
  if (!studio) throw new Error('The packaged Studio window was never created.')

  await studio.getByText('ARRANGEMENT', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
  const browserWindow = await application.browserWindow(studio)
  const visible = await browserWindow.evaluate((window) => window.isVisible())
  if (!visible) throw new Error('Studio rendered but its BrowserWindow was not shown.')

  const startupCloseDeadline = deadline(10_000)
  while (!startup.isClosed() && Date.now() < startupCloseDeadline) await delay(50)
  if (!startup.isClosed()) throw new Error('Startup window remained open after Studio rendered.')

  console.log(`Desktop app rendered Studio from ${executablePath ?? 'the development Electron runtime'}`)
} finally {
  await application?.close().catch(() => {})
  try {
    fs.rmSync(smokeRoot, { recursive: true, force: true })
  } catch (error) {
    console.warn(`Could not remove temporary smoke-test data: ${error.message}`)
  }
}
