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

async function addTrack(page: Page, kind: 'Audio' | 'MIDI') {
  const arrangement = page.getByRole('main', { name: 'Arrangement' })
  const buttonName = kind === 'Audio' ? 'Add audio track' : 'Add MIDI track'
  await arrangement.locator('.arrangement-heading').getByRole('button', { name: buttonName, exact: true }).click()
  const trackName = kind === 'Audio' ? 'New audio' : 'New MIDI'
  const identity = arrangement.getByRole('button', { name: `Select ${trackName} track`, exact: true })
  await expect(identity).toHaveAttribute('aria-current', 'true')
  return identity
}

type StoredTrack = {
  name?: string
  kind?: string
  midi?: {
    channel?: number
    instrument?: { kind?: string; playbackId?: string; program?: number }
  }
  clipCount: number
}

const storedTrack = (page: Page, name: string): Promise<StoredTrack | undefined> => page.evaluate(async (trackName) => {
  const projectId = localStorage.getItem('vibeseq:active-project-id')
  if (!projectId) return undefined
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('vibeseq-projects', 2)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise<StoredTrack | undefined>((resolve, reject) => {
      const request = database.transaction('projects', 'readonly').objectStore('projects').get(projectId)
      request.onsuccess = () => {
        const stored = request.result as {
          checkpoint?: {
            project?: {
              tracks?: Array<{
                name?: string
                kind?: string
                midi?: StoredTrack['midi']
                clips?: unknown[]
              }>
            }
          }
        } | undefined
        const track = stored?.checkpoint?.project?.tracks?.find((item) => item.name === trackName)
        resolve(track ? { name: track.name, kind: track.kind, midi: track.midi, clipCount: track.clips?.length ?? 0 } : undefined)
      }
      request.onerror = () => reject(request.error)
    })
  } finally {
    database.close()
  }
}, name)

test('independent MIDI track routing, Solo, rename, persistence, and delete stay undoable', async ({ page }) => {
  const browserErrors = captureBrowserErrors(page)
  await openStudio(page)

  await addTrack(page, 'MIDI')
  const inspector = page.getByLabel('Selected track inspector')
  await expect(inspector).toContainText('New MIDI')
  const instrument = inspector.getByRole('combobox', { name: 'MIDI instrument profile' })
  const channel = inspector.getByRole('combobox', { name: 'MIDI channel' })
  let program = inspector.getByRole('combobox', { name: 'TinySynth program' })

  await expect(instrument).toHaveValue('melodic')
  await channel.selectOption({ value: '4' })
  await expect(channel).toHaveValue('4')
  await program.selectOption({ value: '40' })
  await expect(program).toHaveValue('40')

  await instrument.selectOption('drums')
  await expect(channel).toBeDisabled()
  await expect(channel).toHaveValue('9')
  await expect(inspector.getByRole('combobox', { name: 'TinySynth program' })).toHaveCount(0)
  await expect(inspector).toContainText('fixed to channel 10')

  await instrument.selectOption('melodic')
  program = inspector.getByRole('combobox', { name: 'TinySynth program' })
  await expect(channel).toBeEnabled()
  await expect(channel).toHaveValue('0')
  await expect(program).toHaveValue('0')
  await channel.selectOption({ value: '4' })
  await expect(channel).toHaveValue('4')
  await program.selectOption({ value: '40' })
  await expect(program).toHaveValue('40')

  const solo = page.getByRole('button', { name: 'Solo New MIDI', exact: true })
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await solo.click()
    await expect(solo).toHaveAttribute('aria-pressed', 'true')
    await solo.click()
    await expect(solo).toHaveAttribute('aria-pressed', 'false')
  }
  await expect(page.getByText(/Solo track blocked|requires an explicit channel and instrument profile/i)).toHaveCount(0)
  await solo.focus()
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await expect(solo).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()

  await inspector.getByRole('button', { name: 'Edit New MIDI track name', exact: true }).click()
  const enterRename = inspector.getByRole('textbox', { name: 'Track name', exact: true })
  await enterRename.fill('Lead Route')
  await enterRename.press('Enter')
  await expect(page.getByRole('button', { name: 'Select Lead Route track', exact: true })).toBeVisible()

  const undo = page.locator('.history-controls').getByRole('button', { name: 'Undo' })
  const redo = page.locator('.history-controls').getByRole('button', { name: 'Redo' })
  await undo.click()
  await expect(page.getByRole('button', { name: 'Select New MIDI track', exact: true })).toBeVisible()
  await redo.click()
  await expect(page.getByRole('button', { name: 'Select Lead Route track', exact: true })).toBeVisible()

  await inspector.getByRole('button', { name: 'Edit Lead Route track name', exact: true }).click()
  const escapeRename = inspector.getByRole('textbox', { name: 'Track name', exact: true })
  await escapeRename.fill('Cancelled name')
  await escapeRename.press('Escape')
  await expect(page.getByRole('button', { name: 'Select Lead Route track', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Select Cancelled name track', exact: true })).toHaveCount(0)

  await inspector.getByRole('button', { name: 'Edit Lead Route track name', exact: true }).click()
  const blurRename = inspector.getByRole('textbox', { name: 'Track name', exact: true })
  await blurRename.fill('Glass Lead')
  await page.locator('.arrangement-heading h1').click()
  await expect(page.getByRole('button', { name: 'Select Glass Lead track', exact: true })).toBeVisible()

  await expect.poll(() => storedTrack(page, 'Glass Lead'), { timeout: 3_000 }).toEqual({
    name: 'Glass Lead',
    kind: 'midi',
    midi: {
      channel: 4,
      instrument: { kind: 'melodic', playbackId: 'WebAudio-TinySynth', program: 40 },
    },
    clipCount: 0,
  })

  await page.reload()
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false')
  const restoredIdentity = page.getByRole('button', { name: 'Select Glass Lead track', exact: true })
  await restoredIdentity.click()
  await expect(page.getByLabel('Selected track inspector').getByRole('combobox', { name: 'MIDI channel' })).toHaveValue('4')
  await expect(page.getByLabel('Selected track inspector').getByRole('combobox', { name: 'TinySynth program' })).toHaveValue('40')

  await page.getByLabel('Selected track inspector').getByRole('button', { name: 'Delete Glass Lead track', exact: true }).click()
  await expect(restoredIdentity).toHaveCount(0)
  await expect(page.getByText('Glass Lead deleted · Undo restores the complete track')).toBeVisible()
  await page.locator('.history-controls').getByRole('button', { name: 'Undo' }).click()
  const undoRestored = page.getByRole('button', { name: 'Select Glass Lead track', exact: true })
  await expect(undoRestored).toBeVisible()
  await undoRestored.click()
  await expect(page.getByLabel('Selected track inspector').getByRole('combobox', { name: 'MIDI channel' })).toHaveValue('4')
  await expect(page.getByLabel('Selected track inspector').getByRole('combobox', { name: 'TinySynth program' })).toHaveValue('40')

  expect(browserErrors).toEqual([])
})

test('selected-track placement, explicit blocking, split shortcut, and Detail collapse preserve intent', async ({ page }) => {
  const browserErrors = captureBrowserErrors(page)
  await openStudio(page)

  const midiIdentity = await addTrack(page, 'MIDI')
  const audioIdentity = await addTrack(page, 'Audio')
  await expect(audioIdentity).toHaveAttribute('aria-current', 'true')

  await page.getByLabel(/PROMPT/).fill('selected audio track placement regression')
  await page.getByLabel('LENGTH').selectOption('seconds:4')
  await page.locator('.generation-controls').getByRole('button', { name: 'Generate', exact: true }).click()
  const candidate = page.locator('.candidate-card').filter({ hasText: 'Variation 1' })
  await expect(candidate).toBeVisible()
  const place = candidate.getByRole('button', { name: 'Place at playhead' })

  await place.click()
  const audioRow = page.locator('.track-row').filter({ has: page.getByRole('button', { name: 'Select New audio track', exact: true }) })
  const placed = audioRow.getByRole('button', { name: /Variation 1, audio region/ })
  await expect(placed).toBeVisible()
  await expect(page.getByText('Audio placed on New audio · source remains immutable')).toBeVisible()
  await expect(page.locator('.track-row')).toHaveCount(2)

  await place.click()
  await expect(page.getByText('Place blocked · Variation 1 already occupies that range on New audio')).toBeVisible()
  await expect(audioRow.getByRole('button', { name: /Variation 1, audio region/ })).toHaveCount(1)
  await expect(page.locator('.track-row')).toHaveCount(2)

  await midiIdentity.click()
  await expect(midiIdentity).toHaveAttribute('aria-current', 'true')
  await place.click()
  await expect(page.getByText('Place blocked · New MIDI is a MIDI track; select an Audio track')).toBeVisible()
  await expect(page.locator('.track-row')).toHaveCount(2)
  await expect(audioRow.getByRole('button', { name: /Variation 1, audio region/ })).toHaveCount(1)

  await placed.click()
  const playhead = page.getByRole('slider', { name: 'Arrangement playhead' })
  await playhead.focus()
  for (let step = 0; step < 4; step += 1) await playhead.press('ArrowRight')
  await expect(playhead).toHaveAttribute('aria-valuenow', '1')
  await page.keyboard.press('s')
  const left = audioRow.getByRole('button', { name: /Variation 1 A, audio region/ })
  const right = audioRow.getByRole('button', { name: /Variation 1 B, audio region/ })
  await expect(left).toBeVisible()
  await expect(right).toHaveAttribute('aria-label', /^Selected,/)

  const detail = page.getByRole('region', { name: 'Detail editor', exact: true })
  await expect(page.getByRole('button', { name: 'Hide detail', exact: true })).toBeVisible()
  await expect(detail.getByRole('heading', { name: 'Variation 1 B', exact: true })).toBeVisible()
  await detail.getByRole('button', { name: 'Collapse detail editor', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Show detail', exact: true })).toBeVisible()
  await expect(page.locator('.status-bar')).toContainText('Region · Variation 1 B')
  await expect(right).toHaveAttribute('aria-label', /^Selected,/)
  await page.getByRole('button', { name: 'Show detail', exact: true }).click()
  await expect(detail.getByRole('heading', { name: 'Variation 1 B', exact: true })).toBeVisible()
  await expect(right).toHaveAttribute('aria-label', /^Selected,/)

  const regionInspector = page.getByLabel('Selected region inspector')
  await expect(regionInspector.getByRole('button', { name: 'Delete Variation 1 B region', exact: true })).toHaveCount(1)
  await expect(regionInspector.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0)
  await regionInspector.getByRole('button', { name: 'Edit Variation 1 B region name', exact: true }).click()
  const regionName = regionInspector.getByRole('textbox', { name: 'Region name', exact: true })
  await regionName.fill('Final Chorus')
  await regionName.press('Enter')
  const renamedRight = audioRow.getByRole('button', { name: /Final Chorus, audio region/ })
  await expect(renamedRight).toHaveAttribute('aria-label', /^Selected,/)

  const undoRegionEdit = page.locator('.history-controls').getByRole('button', { name: 'Undo' })
  const redoRegionEdit = page.locator('.history-controls').getByRole('button', { name: 'Redo' })
  await undoRegionEdit.click()
  await expect(audioRow.getByRole('button', { name: /Variation 1 B, audio region/ })).toBeVisible()
  await redoRegionEdit.click()
  await expect(renamedRight).toBeVisible()

  await regionInspector.getByRole('button', { name: 'Delete Final Chorus region', exact: true }).click()
  await expect(renamedRight).toHaveCount(0)
  await undoRegionEdit.click()
  await expect(renamedRight).toBeVisible()

  expect(browserErrors).toEqual([])
})
