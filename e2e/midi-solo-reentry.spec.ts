import { expect, test, type Page } from '@playwright/test'

const captureBrowserErrors = (page: Page): string[] => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
  })
  return errors
}

async function openStudio(page: Page) {
  await page.goto('/')
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByText('Saved locally · indexeddb')).toBeVisible()
}

async function generateAndExtractMidi(page: Page) {
  await page.getByLabel(/PROMPT/).fill('steady melodic pulse for MIDI re-entry regression')
  await page.getByLabel('LENGTH').selectOption('seconds:4')
  await page.locator('.generation-controls').getByRole('button', { name: 'Generate', exact: true }).click()
  const candidate = page.locator('.candidate-card').filter({ hasText: 'Variation 1' })
  await expect(candidate).toBeVisible()
  await candidate.getByRole('button', { name: 'Place at playhead' }).click()
  await expect(page.getByRole('button', { name: /Variation 1, audio region/ })).toBeVisible()

  await page.locator('.inspector-panel').getByRole('button', { name: 'Extract MIDI', exact: true }).click()
  await expect(page.getByRole('button', { name: /Variation 1 · MIDI, midi region/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Select Extracted MIDI track', exact: true })).toBeVisible()
}

const storedMidiRoute = (page: Page): Promise<{ channel?: number; playbackId?: string } | undefined> => page.evaluate(async () => {
  const projectId = localStorage.getItem('vibeseq:active-project-id')
  if (!projectId) return undefined
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('vibeseq-projects', 2)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise<{ channel?: number; playbackId?: string } | undefined>((resolve, reject) => {
      const request = database.transaction('projects', 'readonly').objectStore('projects').get(projectId)
      request.onsuccess = () => {
        const stored = request.result as {
          checkpoint?: {
            project?: {
              tracks?: Array<{
                kind?: string
                name?: string
                midi?: { channel?: number; instrument?: { playbackId?: string } }
              }>
            }
          }
        } | undefined
        const track = stored?.checkpoint?.project?.tracks?.find((item) => item.kind === 'midi' && item.name === 'Extracted MIDI')
        resolve(track?.midi ? { channel: track.midi.channel, playbackId: track.midi.instrument?.playbackId } : undefined)
      }
      request.onerror = () => reject(request.error)
    })
  } finally {
    database.close()
  }
})

async function dispatchVisibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate((nextState) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => nextState,
    })
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => nextState === 'hidden',
    })
    window.dispatchEvent(new Event(nextState === 'hidden' ? 'blur' : 'focus'))
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}

async function expectSoloCycles(page: Page, cycles = 2) {
  const solo = page.getByRole('button', { name: 'Solo Extracted MIDI', exact: true })
  await expect(solo).toHaveAttribute('aria-pressed', 'false')
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    await solo.click()
    await expect(solo).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText(/requires an explicit channel and instrument profile/i)).toHaveCount(0)
    await solo.click()
    await expect(solo).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByText(/requires an explicit channel and instrument profile/i)).toHaveCount(0)
  }
}

test('MIDI Solo remains editable after screen re-entry and durable reload', async ({ page }) => {
  const browserErrors = captureBrowserErrors(page)
  await openStudio(page)
  await generateAndExtractMidi(page)

  await dispatchVisibility(page, 'hidden')
  await expect.poll(() => storedMidiRoute(page), { timeout: 3_000 }).toEqual({
    channel: 0,
    playbackId: 'WebAudio-TinySynth',
  })
  await dispatchVisibility(page, 'visible')
  await expectSoloCycles(page)

  await dispatchVisibility(page, 'hidden')
  await page.reload()
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByRole('button', { name: 'Select Extracted MIDI track', exact: true })).toBeVisible()
  await expectSoloCycles(page)

  expect(browserErrors).toEqual([])
})
