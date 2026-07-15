import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

async function openStudio(page: import('@playwright/test').Page) {
  await page.goto('/')
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByText('Saved locally · indexeddb')).toBeVisible()
}

async function openProjectDialog(page: import('@playwright/test').Page) {
  await page.getByRole('banner', { name: 'Project transport' }).getByRole('button', { name: 'Open project menu' }).click()
  const dialog = page.getByRole('dialog', { name: 'Project' })
  await expect(dialog).toBeVisible()
  return dialog
}

test('portable bundle round-trips meter, arrangement, candidates, jobs, and verified binary media', async ({ page }) => {
  await openStudio(page)

  await page.getByLabel(/PROMPT/).fill('portable T4 pulse with dry transients, 120 BPM')
  await page.getByLabel('LENGTH').selectOption('seconds:4')
  await page.getByRole('spinbutton', { name: 'Generation seed', exact: true }).fill('98765')
  await page.getByRole('spinbutton', { name: 'Generation seed', exact: true }).press('Enter')
  await page.locator('.generation-controls').getByRole('button', { name: 'Generate', exact: true }).click()
  const candidate = page.locator('.candidate-card').filter({ hasText: 'Variation 1' })
  await expect(candidate).toBeVisible()
  await expect(candidate).toContainText('Seed 98765')
  await candidate.getByRole('button', { name: 'Place at playhead' }).click()
  await expect(page.getByRole('button', { name: /Variation 1, audio region/ })).toBeVisible()

  await page.getByRole('button', { name: 'Extract MIDI', exact: true }).click()
  await expect(page.getByRole('button', { name: /Variation 1 · MIDI, midi region/ })).toBeVisible()

  let dialog = await openProjectDialog(page)
  await dialog.getByLabel('Project name').fill('Portable Colab Session')
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(page.locator('.arrangement-heading h1')).toHaveText('Portable Colab Session')

  dialog = await openProjectDialog(page)
  const meter = dialog.getByLabel('Project time signature')
  await meter.selectOption('6/8')
  await expect(meter).toHaveValue('6/8')
  await dialog.getByRole('button', { name: 'Close project menu' }).click()
  await expect(page.getByLabel('LENGTH').locator('option[value="bars:2"]')).toHaveText('2 bars · 3.00 sec')

  const undo = page.locator('.history-controls').getByRole('button', { name: 'Undo' })
  const redo = page.locator('.history-controls').getByRole('button', { name: 'Redo' })
  await undo.click()
  await expect(page.getByLabel('LENGTH').locator('option[value="bars:2"]')).toHaveText('2 bars · 4.00 sec')
  await redo.click()
  await expect(page.getByLabel('LENGTH').locator('option[value="bars:2"]')).toHaveText('2 bars · 3.00 sec')

  dialog = await openProjectDialog(page)
  const bundleDownloadPromise = page.waitForEvent('download')
  await dialog.getByRole('button', { name: /Export project bundle/ }).click()
  const bundleDownload = await bundleDownloadPromise
  expect(bundleDownload.suggestedFilename()).toBe('Portable-Colab-Session.vibeseq')
  const bundlePath = await bundleDownload.path()
  expect(bundlePath).not.toBeNull()
  const bundleBytes = await readFile(bundlePath!)
  const bundle = JSON.parse(bundleBytes.toString()) as {
    format: string
    serializationVersion: number
    project: {
      name: string
      timeSignature: { numerator: number; denominator: number }
      assets: Array<Record<string, unknown>>
      jobs: Array<Record<string, unknown>>
    }
    session: {
      candidates: Array<Record<string, unknown>>
      activeJob?: unknown
    }
  }
  expect(bundle.format).toBe('vibeseq-project')
  expect(bundle.serializationVersion).toBe(1)
  expect(bundle.project.name).toBe('Portable Colab Session')
  expect(bundle.project.timeSignature).toEqual({ numerator: 6, denominator: 8 })
  expect(bundle.project.assets.length).toBeGreaterThan(0)
  expect(bundle.project.jobs.length).toBeGreaterThanOrEqual(2)
  expect(bundle.session.candidates).toHaveLength(1)
  expect((bundle.project.jobs[0].input as { seed?: number }).seed).toBe(98_765)
  expect(bundle.session.candidates[0].seed).toBe(98_765)
  expect(bundle.project.assets.some((asset) => {
    const envelope = asset.blob ?? asset.bytes
    return Boolean(envelope && typeof envelope === 'object' && '__vibeseqBinary' in envelope && 'base64' in envelope)
  })).toBe(true)
  expect(bundle.session.candidates.some((entry) => {
    const envelope = entry.blob ?? entry.bytes
    return Boolean(envelope && typeof envelope === 'object' && '__vibeseqBinary' in envelope && 'base64' in envelope)
  })).toBe(true)

  // Export is a durability barrier, so an immediate reload must retain the
  // latest meter and edits without waiting for the 450 ms autosave debounce.
  await page.reload()
  await expect(page.locator('.arrangement-heading h1')).toHaveText('Portable Colab Session')
  await expect(page.getByRole('button', { name: /Variation 1 · MIDI, midi region/ })).toBeVisible()
  dialog = await openProjectDialog(page)
  await expect(dialog.getByLabel('Project time signature')).toHaveValue('6/8')

  await dialog.getByRole('button', { name: /New project/ }).click()
  await expect(page.locator('.arrangement-heading h1')).toHaveText('Untitled Sequence')
  await expect(page.getByText('Your arrangement is empty')).toBeVisible()

  const bundleInput = page.locator('input[accept*=".vibeseq"]')
  await bundleInput.setInputFiles(bundlePath!)
  await expect(page.getByText(/Imported Portable Colab Session · portable media verified/)).toBeVisible()
  await expect(page.locator('.arrangement-heading h1')).toHaveText('Portable Colab Session')
  await expect(page.getByRole('button', { name: /Variation 1, audio region/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Variation 1 · MIDI, midi region/ })).toBeVisible()
  await expect(page.locator('.candidate-card').filter({ hasText: 'Variation 1' })).toBeVisible()
  await expect(page.locator('.candidate-card').filter({ hasText: 'Variation 1' })).toContainText('Seed 98765')

  await page.reload()
  await expect(page.locator('.arrangement-heading h1')).toHaveText('Portable Colab Session')
  dialog = await openProjectDialog(page)
  await expect(dialog.getByLabel('Project time signature')).toHaveValue('6/8')
  await dialog.getByRole('button', { name: /Export render/ }).click()
  const midiDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: /MIDI structure/ }).click()
  const midiDownload = await midiDownloadPromise
  const midiPath = await midiDownload.path()
  expect(midiPath).not.toBeNull()
  const midi = await readFile(midiPath!)
  expect(midi.indexOf(Buffer.from([0xff, 0x58, 0x04, 0x06, 0x03]))).toBeGreaterThanOrEqual(0)

  const tampered = structuredClone(bundle) as typeof bundle
  const encodedAsset = tampered.project.assets.find((asset) => asset.blob || asset.bytes)!
  const binary = (encodedAsset.blob ?? encodedAsset.bytes) as { base64: string }
  binary.base64 = `${binary.base64[0] === 'A' ? 'B' : 'A'}${binary.base64.slice(1)}`
  const clipCountBefore = await page.locator('.timeline-clip').count()
  await bundleInput.setInputFiles({
    name: 'tampered.vibeseq',
    mimeType: 'application/vnd.vibeseq.project+json',
    buffer: Buffer.from(JSON.stringify(tampered)),
  })
  await expect(page.getByText(/Project bundle import failed · current project kept/)).toBeVisible()
  await expect(page.locator('.arrangement-heading h1')).toHaveText('Portable Colab Session')
  await expect(page.locator('.timeline-clip')).toHaveCount(clipCountBefore)
})
