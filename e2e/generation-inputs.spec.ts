import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

async function openStudio(page: import('@playwright/test').Page) {
  await page.goto('/')
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false')
}

const storedProjectBpm = (page: import('@playwright/test').Page): Promise<number | undefined> => page.evaluate(async () => {
  const projectId = localStorage.getItem('vibeseq:active-project-id')
  if (!projectId) return undefined
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('vibeseq-projects', 2)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise<number | undefined>((resolve, reject) => {
      const request = database.transaction('projects', 'readonly').objectStore('projects').get(projectId)
      request.onsuccess = () => resolve((request.result as { checkpoint?: { project?: { bpm?: number } } } | undefined)?.checkpoint?.project?.bpm)
      request.onerror = () => reject(request.error)
    })
  } finally {
    database.close()
  }
})

test('tempo edits commit once on Enter or blur and Escape cancels the draft', async ({ page }) => {
  await openStudio(page)
  const tempo = page.getByRole('spinbutton', { name: 'Tempo', exact: true })
  const undo = page.locator('.history-controls').getByRole('button', { name: 'Undo' })

  await tempo.fill('90')
  await expect(tempo).toHaveValue('90')
  await expect(undo).toBeDisabled()
  await expect(page.getByLabel('LENGTH').locator('option[value="bars:2"]')).toHaveText('2 bars · 4.00 sec')
  await tempo.press('Enter')
  await expect(tempo).toHaveValue('90.0')
  await expect(undo).toBeEnabled()
  await expect(page.getByLabel('LENGTH').locator('option[value="bars:2"]')).toHaveText('2 bars · 5.33 sec')

  await tempo.fill('100')
  await tempo.press('Enter')
  await expect(tempo).toHaveValue('100.0')
  await undo.click()
  await expect(tempo).toHaveValue('90.0')

  await undo.click()
  await expect(tempo).toHaveValue('120.0')
  await expect(undo).toBeDisabled()

  await tempo.fill('105')
  await page.locator('.position-block').click()
  await expect(tempo).toHaveValue('105.0')
  await expect(undo).toBeEnabled()

  await undo.click()
  await tempo.fill('80')
  await tempo.press('Escape')
  await expect(tempo).toHaveValue('120.0')
  await expect(undo).toBeDisabled()
})

test('generation seed commits on Enter or blur, Escape restores, and randomize is submitted exactly', async ({ page }) => {
  await openStudio(page)
  await page.getByLabel(/PROMPT/).fill('reproducible dry percussion fixture')
  await page.getByLabel('LENGTH').selectOption('seconds:4')
  const seed = page.getByRole('spinbutton', { name: 'Generation seed', exact: true })
  const generate = page.locator('.generation-controls').getByRole('button', { name: 'Generate', exact: true })
  const initialSeed = Number(await seed.inputValue())
  expect(Number.isInteger(initialSeed)).toBe(true)
  expect(initialSeed).toBeGreaterThanOrEqual(0)
  expect(initialSeed).toBeLessThanOrEqual(0xffff_ffff)

  // A DOM click does not blur the focused field, so this proves the draft did
  // not mutate the committed seed on each keystroke.
  await seed.fill('61061')
  const initialRequestPromise = page.waitForRequest((request) => request.url().endsWith('/api/generate') && request.method() === 'POST')
  await generate.evaluate((button: HTMLButtonElement) => button.click())
  const initialRequest = await initialRequestPromise
  expect((initialRequest.postDataJSON() as { seed: number }).seed).toBe(initialSeed)
  const firstCandidate = page.locator('.candidate-card').filter({ hasText: 'Variation 1' })
  await expect(firstCandidate).toContainText(`Seed ${initialSeed}`)

  await seed.press('Enter')
  await expect(seed).toHaveValue('61061')
  const committedRequestPromise = page.waitForRequest((request) => request.url().endsWith('/api/generate') && request.method() === 'POST')
  await generate.click()
  const committedRequest = await committedRequestPromise
  expect((committedRequest.postDataJSON() as { seed: number }).seed).toBe(61_061)
  await expect(page.locator('.candidate-card').filter({ hasText: 'Variation 2' })).toContainText('Seed 61061')

  await seed.fill('68309')
  await page.getByLabel(/PROMPT/).click()
  await expect(seed).toHaveValue('68309')
  await seed.fill('1234')
  await seed.press('Escape')
  await expect(seed).toHaveValue('68309')

  const randomize = page.getByRole('button', { name: 'Randomize generation seed' })
  await randomize.click()
  const randomizedSeed = Number(await seed.inputValue())
  expect(Number.isInteger(randomizedSeed)).toBe(true)
  expect(randomizedSeed).toBeGreaterThanOrEqual(0)
  expect(randomizedSeed).toBeLessThanOrEqual(0xffff_ffff)
  expect(randomizedSeed).not.toBe(68_309)

  const randomizedRequestPromise = page.waitForRequest((request) => request.url().endsWith('/api/generate') && request.method() === 'POST')
  await generate.click()
  const randomizedRequest = await randomizedRequestPromise
  expect((randomizedRequest.postDataJSON() as { seed: number }).seed).toBe(randomizedSeed)
  await expect(page.locator('.candidate-card').filter({ hasText: 'Variation 3' })).toContainText(`Seed ${randomizedSeed}`)
})

test('bar-based generation resolves the submitted seconds from BPM and meter', async ({ page }) => {
  await openStudio(page)
  const tempo = page.getByRole('spinbutton', { name: 'Tempo', exact: true })
  await tempo.fill('90')
  await tempo.press('Enter')

  const length = page.getByLabel('LENGTH')
  await expect(length.locator('option[value="bars:2"]')).toHaveText('2 bars · 5.33 sec')
  await length.selectOption('bars:2')
  await page.getByLabel(/PROMPT/).fill('seamless two-bar percussion loop, dry transients')

  const submitted = page.waitForRequest((request) => request.url().endsWith('/api/generate') && request.method() === 'POST')
  await page.locator('.generation-controls').getByRole('button', { name: 'Generate', exact: true }).click()
  const request = await submitted
  const body = request.postDataJSON() as { duration: number; bpm: number }
  expect(body.bpm).toBe(90)
  expect(body.duration).toBeCloseTo(16 / 3, 8)

  const candidate = page.locator('.candidate-card').filter({ hasText: 'Variation 1' })
  await expect(candidate).toBeVisible()
  await expect(candidate.locator('.candidate-length')).toHaveText('2 bars · 5.33 sec @ 90.0 BPM')
})

test('seconds audio stays fixed while bar audio follows tempo with explicit repitch', async ({ page }) => {
  await openStudio(page)
  const length = page.getByLabel('LENGTH')
  const generate = page.locator('.generation-controls').getByRole('button', { name: 'Generate', exact: true })

  await length.selectOption('seconds:4')
  await page.getByLabel(/PROMPT/).fill('four second impact with a clean tail')
  await generate.click()
  const fixedCandidate = page.locator('.candidate-card').filter({ hasText: 'Variation 1' })
  await fixedCandidate.getByRole('button', { name: 'Place at playhead' }).click()
  const fixedRegion = page.getByRole('button', { name: /Variation 1, audio region/ })
  await expect(fixedRegion).toHaveAttribute('aria-label', /duration 8\.00 beats/)
  let inspector = page.getByLabel('Selected region inspector')
  await expect(inspector).toContainText('Fixed seconds')
  await expect(inspector).toContainText('1.00×')

  await length.selectOption('bars:2')
  await page.getByLabel(/PROMPT/).fill('seamless two bar drum loop')
  await generate.click()
  const musicalCandidate = page.locator('.candidate-card').filter({ hasText: 'Variation 2' })
  await page.locator('.arrangement-heading').getByRole('button', { name: 'Add audio track', exact: true }).click()
  await musicalCandidate.getByRole('button', { name: 'Place at playhead' }).click()
  const musicalRegion = page.getByRole('button', { name: /Variation 2, audio region/ })
  await expect(musicalRegion).toHaveAttribute('aria-label', /duration 8\.00 beats/)
  inspector = page.getByLabel('Selected region inspector')
  await expect(inspector).toContainText('Follow tempo · repitch')
  await expect(inspector).toContainText('Authored at 120.0 BPM')

  const tempo = page.getByRole('spinbutton', { name: 'Tempo', exact: true })
  await tempo.fill('60')
  await tempo.press('Enter')
  await expect(fixedRegion).toHaveAttribute('aria-label', /duration 4\.00 beats/)
  await expect(musicalRegion).toHaveAttribute('aria-label', /duration 8\.00 beats/)
  await expect(inspector).toContainText('0.50×')
  await musicalRegion.dblclick()
  await expect(page.getByRole('region', { name: 'Detail editor', exact: true })).toContainText('TEMPO FOLLOW · REPITCH 0.50×')

  const undo = page.locator('.history-controls').getByRole('button', { name: 'Undo' })
  const redo = page.locator('.history-controls').getByRole('button', { name: 'Redo' })
  await undo.click()
  await expect(tempo).toHaveValue('120.0')
  await expect(fixedRegion).toHaveAttribute('aria-label', /duration 8\.00 beats/)
  await expect(inspector).toContainText('1.00×')
  await redo.click()
  await expect(tempo).toHaveValue('60.0')
  await expect(fixedRegion).toHaveAttribute('aria-label', /duration 4\.00 beats/)
  await expect.poll(() => storedProjectBpm(page), { timeout: 3_000 }).toBe(60)

  await page.reload()
  await expect(tempo).toHaveValue('60.0')
  await expect(fixedRegion).toHaveAttribute('aria-label', /duration 4\.00 beats/)
  await expect(musicalRegion).toHaveAttribute('aria-label', /duration 8\.00 beats/)

  await page.getByRole('banner', { name: 'Project transport' }).getByRole('button', { name: 'Open project menu' }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('dialog', { name: 'Project' }).getByRole('button', { name: /Export project bundle/ }).click()
  const download = await downloadPromise
  const downloadPath = await download.path()
  expect(downloadPath).not.toBeNull()
  const bundle = JSON.parse(await readFile(downloadPath!, 'utf8')) as {
    project: { schemaVersion: number; tracks: Array<{ clips: Array<{ name: string; timebase?: { mode: string; sourceBpm: number } }> }> }
  }
  expect(bundle.project.schemaVersion).toBe(4)
  const timings = new Map(bundle.project.tracks.flatMap((track) => track.clips.map((clip) => [clip.name, clip.timebase] as const)))
  expect(timings.get('Variation 1')).toEqual({ mode: 'fixed-seconds', sourceBpm: 60 })
  expect(timings.get('Variation 2')).toEqual({ mode: 'tempo-follow-repitch', sourceBpm: 120 })
})
