import { expect, test } from '@playwright/test'

async function openStudio(page: import('@playwright/test').Page) {
  await page.goto('/')
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false')
}

const captureBrowserErrors = (page: import('@playwright/test').Page): string[] => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
  })
  return errors
}

const storedProjectClipNames = (page: import('@playwright/test').Page): Promise<string[]> => page.evaluate(async () => {
  const projectId = localStorage.getItem('vibeseq:active-project-id')
  if (!projectId) return []
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('vibeseq-projects', 2)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const request = database.transaction('projects', 'readonly').objectStore('projects').get(projectId)
      request.onsuccess = () => {
        const stored = request.result as {
          checkpoint?: { project?: { tracks?: Array<{ clips?: Array<{ name?: string }> }> } }
        } | undefined
        resolve(stored?.checkpoint?.project?.tracks?.flatMap((track) => track.clips?.flatMap((clip) => clip.name ?? []) ?? []) ?? [])
      }
      request.onerror = () => reject(request.error)
    })
  } finally {
    database.close()
  }
})

test('generated sounds remain globally available across local projects without owning project clips', async ({ page }) => {
  const browserErrors = captureBrowserErrors(page)
  await openStudio(page)
  const source = page.getByRole('complementary', { name: 'Sound source' })

  await page.getByLabel(/PROMPT/).fill('global library fixture, short dry percussion')
  await source.locator('.generation-controls').getByRole('button', { name: 'Generate', exact: true }).click()
  await expect(page.getByText(/Variation ready · saved to the global Sound Library/)).toBeVisible()
  const candidateWaveformBox = await source.locator('.candidate-card').filter({ hasText: 'Variation 1' }).locator('.candidate-waveform').boundingBox()
  expect(candidateWaveformBox).not.toBeNull()
  expect(candidateWaveformBox!.height).toBeGreaterThanOrEqual(42)

  await source.getByRole('button', { name: 'Library', exact: true }).click()
  const libraryCard = source.locator('.library-card').filter({ hasText: 'Variation 1' })
  await expect(libraryCard).toBeVisible()
  const [libraryListBox, libraryCardBox] = await Promise.all([
    source.locator('.library-list').boundingBox(),
    libraryCard.boundingBox(),
  ])
  expect(libraryListBox).not.toBeNull()
  expect(libraryCardBox).not.toBeNull()
  expect(libraryCardBox!.y - libraryListBox!.y).toBeGreaterThanOrEqual(1)
  const libraryWaveformBox = await libraryCard.locator('.candidate-waveform').boundingBox()
  expect(libraryWaveformBox).not.toBeNull()
  expect(Math.abs(libraryWaveformBox!.height - candidateWaveformBox!.height)).toBeLessThanOrEqual(0.5)
  await expect(source.getByRole('textbox', { name: 'Search Sound Library' })).toBeVisible()

  await page.getByRole('banner', { name: 'Project transport' }).getByRole('button', { name: 'Open project menu' }).click()
  await page.getByRole('dialog', { name: 'Project' }).getByRole('button', { name: /New project/ }).click()
  await expect(page.getByText('Your arrangement is empty')).toBeVisible()

  await expect(libraryCard).toBeVisible()
  await libraryCard.getByRole('button', { name: 'Place at playhead' }).click()
  const placed = page.getByRole('button', { name: /Variation 1, audio region/ })
  await expect(placed).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept())
  await libraryCard.getByRole('button', { name: 'Delete Variation 1 from Sound Library' }).click()
  await expect(source.getByText('Generated sounds appear here across every local project.')).toBeVisible()
  await expect(placed).toBeVisible()

  // The existing "Saved locally" status can still describe the newly-created
  // empty project while this edit is inside the autosave debounce. Prove the
  // active checkpoint contains the placed clip before testing reload durability.
  await expect.poll(() => storedProjectClipNames(page), { timeout: 3_000 }).toContain('Variation 1')

  await page.reload()
  await source.getByRole('button', { name: 'Library', exact: true }).click()
  await expect(source.locator('.library-card')).toHaveCount(0)
  await expect(placed).toBeVisible()
  expect(browserErrors).toEqual([])
})

test('Generate, Import, and Library are real reachable source modes', async ({ page }) => {
  const browserErrors = captureBrowserErrors(page)
  await openStudio(page)
  const source = page.getByRole('complementary', { name: 'Sound source' })

  await source.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(source.getByRole('heading', { name: 'Import audio' })).toBeVisible()
  await expect(source.getByRole('button', { name: 'Choose audio file' })).toBeVisible()

  await source.getByRole('button', { name: 'Library', exact: true }).click()
  await expect(source.getByRole('heading', { name: 'Sound Library' })).toBeVisible()
  await expect(source.getByRole('textbox', { name: 'Search Sound Library' })).toBeVisible()

  await source.getByRole('button', { name: 'Generate', exact: true }).click()
  await expect(source.getByRole('heading', { name: 'Generate sound' })).toBeVisible()
  await expect(page.getByLabel(/PROMPT/)).toBeVisible()
  expect(browserErrors).toEqual([])
})
