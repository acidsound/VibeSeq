import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const disableDurableStorage = (page: Page) => page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      value: {
        open: () => { throw new DOMException('Injected IndexedDB failure', 'UnknownError') },
      },
    })
    const originalGetItem = Storage.prototype.getItem
    Storage.prototype.getItem = function getItem(key: string) {
      return originalGetItem.call(this, key)
    }
    Storage.prototype.setItem = function setItem() {
      throw new DOMException('Injected storage quota failure', 'QuotaExceededError')
    }
  })

test('quota failure never claims durability and current work exports as a recovery bundle', async ({ page }) => {
  await disableDurableStorage(page)

  await page.goto('/')
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false')
  const alert = page.getByRole('alert', { name: 'Local save requires attention' })
  await expect(alert).toBeVisible()
  await expect(alert).toContainText('Current work is not durably saved')
  await expect(alert).toContainText(/storage is full|not safely saved/i)
  await expect(page.locator('.status-bar')).toContainText(/Save failed|Session only/)
  await expect(page.locator('.status-bar')).not.toContainText('Saved locally')

  const tempo = page.getByRole('spinbutton', { name: 'Tempo' })
  await tempo.fill('95')
  await tempo.press('Enter')
  await expect(tempo).toHaveValue('95.0')
  await alert.getByRole('button', { name: 'Retry save' }).click()
  await expect(alert).toBeVisible()

  const downloadPromise = page.waitForEvent('download')
  await alert.getByRole('button', { name: 'Export recovery bundle' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('Untitled-Sequence-recovery.vibeseq')
  const downloadPath = await download.path()
  expect(downloadPath).not.toBeNull()
  const bundle = JSON.parse(await readFile(downloadPath!, 'utf8')) as {
    format: string
    revision: number
    project: { bpm: number }
  }
  expect(bundle.format).toBe('vibeseq-project')
  expect(Number.isSafeInteger(bundle.revision)).toBe(true)
  expect(bundle.project.bpm).toBe(95)
  if (process.env.VIBESEQ_QA_EVIDENCE === '1') {
    const evidenceDirectory = path.resolve('artifacts/qa/2026-07-15-persistence-recovery')
    await mkdir(evidenceDirectory, { recursive: true })
    await download.saveAs(path.join(evidenceDirectory, download.suggestedFilename()))
  }
  await expect(page.getByText(/Recovery bundle exported from the current in-memory workspace/)).toBeVisible()

  await page.getByRole('banner', { name: 'Project transport' }).getByRole('button', { name: 'Open project menu' }).click()
  const projectDialog = page.getByRole('dialog', { name: 'Project' })
  await expect(projectDialog).toBeVisible()
  await projectDialog.getByRole('button', { name: /New project/ }).click()
  await expect(page.getByText(/New project blocked · current project kept/)).toBeVisible()
  await expect(tempo).toHaveValue('95.0')
})

test('mobile recovery actions remain reachable when durable storage is unavailable', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 })
  await disableDurableStorage(page)
  await page.goto('/')
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false')

  const alert = page.getByRole('alert', { name: 'Local save requires attention' })
  await expect(alert).toBeVisible()
  for (const name of ['Retry save', 'Export recovery bundle']) {
    const bounds = await alert.getByRole('button', { name }).boundingBox()
    expect(bounds?.height).toBeGreaterThanOrEqual(44)
  }
  const layout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }))
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth)
})

test('startup discovers and recovers an interrupted save for a different project id', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByText('Saved locally · indexeddb')).toBeVisible()

  await page.getByRole('banner', { name: 'Project transport' }).getByRole('button', { name: 'Open project menu' }).click()
  const projectDialog = page.getByRole('dialog', { name: 'Project' })
  const downloadPromise = page.waitForEvent('download')
  await projectDialog.getByRole('button', { name: /Export project bundle/ }).click()
  const download = await downloadPromise
  const downloadPath = await download.path()
  expect(downloadPath).not.toBeNull()
  const checkpoint = JSON.parse(await readFile(downloadPath!, 'utf8')) as {
    checkpointId: string
    revision: number
    savedAt: string
    project: { id: string; name: string; updatedAt: string }
  }
  const recoveryProjectId = 'project-browser-recovery'
  const recoverySavedAt = new Date(Date.parse(checkpoint.savedAt) + 1_000).toISOString()
  checkpoint.checkpointId = 'checkpoint-browser-recovery'
  checkpoint.revision += 1_000
  checkpoint.savedAt = recoverySavedAt
  checkpoint.project.id = recoveryProjectId
  checkpoint.project.name = 'Recovered Side Project'
  checkpoint.project.updatedAt = recoverySavedAt
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key: `vibeseq:recovery:${recoveryProjectId}`,
    value: JSON.stringify(checkpoint),
  })

  await page.reload()
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false')
  const recoveryDialog = page.getByRole('alertdialog', { name: 'Interrupted save found' })
  await expect(recoveryDialog).toBeVisible()
  await expect(recoveryDialog).toContainText('Recovered Side Project')
  await recoveryDialog.getByRole('button', { name: 'Recover newer work' }).click()
  await expect(recoveryDialog).not.toBeVisible()
  await expect(page.locator('.arrangement-heading h1')).toHaveText('Recovered Side Project')
  await expect(page.getByText('Saved locally · indexeddb')).toBeVisible()

  await page.reload()
  await expect(page.locator('.arrangement-heading h1')).toHaveText('Recovered Side Project')
  await expect(page.getByRole('alertdialog', { name: 'Interrupted save found' })).toHaveCount(0)
})
