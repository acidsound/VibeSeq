import { expect, test, type Locator, type Page } from '@playwright/test'

const AUDIO_COMMAND_IDS = [
  'open-detail',
  'split',
  'duplicate',
  'clip-mute',
  'clip-source-loop',
  'extract-midi',
  'delete',
]

async function openStudio(page: Page) {
  await page.goto('/')
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('.arrangement-panel')).toBeVisible()
}

async function generateAndPlace(page: Page) {
  await page.getByLabel(/PROMPT/).fill('focused electric pulse, steady notes, 120 BPM')
  await page.getByLabel('LENGTH').selectOption('seconds:4')
  await page.locator('.generation-controls').getByRole('button', { name: 'Generate', exact: true }).click()
  const candidate = page.locator('.candidate-card').filter({ hasText: 'Variation 1' })
  await expect(candidate).toBeVisible()
  await candidate.getByRole('button', { name: 'Place at playhead' }).click()
  const clip = page.getByRole('button', { name: /Variation 1, audio region/ })
  await expect(clip).toBeVisible()
  return clip
}

async function extractMidi(page: Page) {
  await page.locator('.inspector-panel').getByRole('button', { name: 'Extract MIDI', exact: true }).click()
  const clip = page.getByRole('button', { name: /Variation 1 · MIDI, midi region/ })
  await expect(clip).toBeVisible()
  await expect(page.locator('.piano-note').first()).toBeVisible()
  return clip
}

async function commandIds(menu: Locator) {
  return menu.locator('[data-command-id]').evaluateAll((items) => items.map((item) => item.getAttribute('data-command-id')))
}

async function seekToBeat(page: Page, beat: number) {
  const ruler = page.locator('.timeline-ruler')
  const bounds = await ruler.boundingBox()
  expect(bounds).not.toBeNull()
  const timelineBeats = Number(await ruler.getAttribute('data-timeline-beats'))
  expect(timelineBeats).toBeGreaterThan(0)
  await page.mouse.click(bounds!.x + (beat / timelineBeats) * bounds!.width, bounds!.y + bounds!.height / 2)
  await expect(page.getByRole('slider', { name: 'Arrangement playhead' })).toHaveAttribute('aria-valuenow', String(beat))
}

async function expectTouchTarget(locator: Locator) {
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBeGreaterThanOrEqual(44)
  expect(box!.height).toBeGreaterThanOrEqual(44)
}

function clipTiming(label: string | null) {
  const match = label?.match(/starts at beat ([\d.]+), duration ([\d.]+) beats/)
  expect(match, `clip timing must be exposed in ${label ?? '<missing label>'}`).not.toBeNull()
  return { startBeat: Number(match![1]), durationBeats: Number(match![2]) }
}

test('source-loop enable and disable stay visible, preserve placement, and undo independently', async ({ page }) => {
  await openStudio(page)
  const audioClip = await generateAndPlace(page)

  await audioClip.focus()
  await audioClip.press('Shift+F10')
  let menu = page.getByRole('menu', { name: 'Commands for Variation 1' })
  await expect(menu).toBeVisible()
  expect(await commandIds(menu)).toEqual(AUDIO_COMMAND_IDS)
  await expect(menu.getByRole('menuitem', { name: /^Split at/ })).toBeDisabled()
  await expect(menu.getByRole('menuitem', { name: 'Enable clip loop' })).toContainText('Source repeat · not project cycle')
  await menu.getByRole('menuitem', { name: 'Enable clip loop' }).click()

  await expect(audioClip).toHaveAttribute('aria-label', /clip source loop enabled/)
  const region = page.getByRole('group', { name: 'Variation 1 region controls' })
  await expect(region.locator('.clip-loop-notch')).toHaveCount(1)
  const cycleEnd = region.getByRole('button', { name: /Change source cycle end of Variation 1/ })
  const loopExtent = region.getByRole('button', { name: /Change clip loop extent of Variation 1/ })
  await expect(cycleEnd).toBeVisible()
  await expect(loopExtent).toBeVisible()
  const cycleBox = await cycleEnd.boundingBox()
  const extentBox = await loopExtent.boundingBox()
  expect(cycleBox).not.toBeNull()
  expect(extentBox).not.toBeNull()
  expect(cycleBox!.x + cycleBox!.width / 2).toBeLessThan(extentBox!.x + extentBox!.width / 2)
  await expect(region.getByRole('button', { name: 'Trim end of Variation 1' })).toHaveCount(0)

  await audioClip.focus()
  await audioClip.press('Shift+F10')
  menu = page.getByRole('menu', { name: 'Commands for Variation 1' })
  await expect(menu.getByRole('menuitem', { name: 'Disable clip loop' })).toBeVisible()
  const loopedTiming = clipTiming(await audioClip.getAttribute('aria-label'))
  await menu.getByRole('menuitem', { name: 'Disable clip loop' }).click()

  await expect(audioClip).not.toHaveAttribute('aria-label', /clip source loop enabled/)
  expect(clipTiming(await audioClip.getAttribute('aria-label'))).toEqual(loopedTiming)
  await expect(region.locator('.clip-loop-notch')).toHaveCount(0)
  await expect(region.getByRole('button', { name: 'Trim end of Variation 1' })).toBeVisible()

  await page.locator('.history-controls').getByRole('button', { name: 'Undo' }).click()
  await expect(audioClip).toHaveAttribute('aria-label', /clip source loop enabled/)
  await expect(region.locator('.clip-loop-notch')).toHaveCount(1)

  await page.locator('.history-controls').getByRole('button', { name: 'Undo' }).click()
  await expect(audioClip).not.toHaveAttribute('aria-label', /clip source loop enabled/)
  await expect(region.locator('.clip-loop-notch')).toHaveCount(0)
  await expect(region.getByRole('button', { name: /Change source cycle end/ })).toHaveCount(0)
  await expect(region.getByRole('button', { name: /Change clip loop extent/ })).toHaveCount(0)
  await expect(region.getByRole('button', { name: 'Trim end of Variation 1' })).toBeVisible()
})

test('region mute is visible, accessible, undoable, and durable from inspector and clip commands', async ({ page }) => {
  await openStudio(page)
  let audioClip = await generateAndPlace(page)
  const region = page.getByRole('group', { name: 'Variation 1 region controls' })
  const inspector = page.getByLabel('Selected region inspector')
  const mute = inspector.getByRole('button', { name: 'Mute region' })

  await expect(mute).toHaveAttribute('aria-pressed', 'false')
  await mute.click()
  await expect(inspector.getByRole('button', { name: 'Unmute region' })).toHaveAttribute('aria-pressed', 'true')
  await expect(audioClip).toHaveAttribute('aria-label', /muted/)
  await expect(region).toHaveClass(/is-muted/)
  await expect(region.locator('.clip-muted-icon')).toHaveCount(1)

  await audioClip.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Commands for Variation 1' })
  expect(await commandIds(menu)).toEqual(AUDIO_COMMAND_IDS)
  await expect(menu.getByRole('menuitem', { name: 'Unmute region' })).toContainText('Restore playback + export')
  await menu.getByRole('menuitem', { name: 'Unmute region' }).click()
  await expect(audioClip).not.toHaveAttribute('aria-label', /muted/)
  await expect(region).not.toHaveClass(/is-muted/)

  const undo = page.locator('.history-controls').getByRole('button', { name: 'Undo' })
  await undo.click()
  await expect(audioClip).toHaveAttribute('aria-label', /muted/)
  await undo.click()
  await expect(audioClip).not.toHaveAttribute('aria-label', /muted/)

  await inspector.getByRole('button', { name: 'Mute region' }).click()
  await page.waitForTimeout(700)
  await page.reload()
  audioClip = page.getByRole('button', { name: /Variation 1, audio region/ })
  await expect(audioClip).toHaveAttribute('aria-label', /muted/)
  await expect(page.getByRole('group', { name: 'Variation 1 region controls' })).toHaveClass(/is-muted/)
})

test('MIDI crossing-note split is cancel-safe and Split notes applies the chosen policy', async ({ page }) => {
  await openStudio(page)
  await generateAndPlace(page)
  const midiClip = await extractMidi(page)

  const firstNote = page.locator('.piano-note').first()
  await firstNote.click()
  const selectedSourceNote = page.locator('.piano-note.is-selected')
  await page.getByLabel('Selected note start beat').fill('1')
  await page.getByLabel('Selected note duration beats').fill('2')
  await expect(selectedSourceNote).toHaveAttribute('aria-label', /starts at 1\.00 beats, duration 2\.00 beats/)
  const originalNoteCount = await page.locator('.piano-note').count()
  const originalClipLabel = await midiClip.getAttribute('aria-label')

  await seekToBeat(page, 2)
  await midiClip.click({ button: 'right' })
  let menu = page.getByRole('menu', { name: 'Commands for Variation 1 · MIDI' })
  expect(await commandIds(menu)).toEqual(AUDIO_COMMAND_IDS.filter((id) => id !== 'extract-midi'))
  await menu.getByRole('menuitem', { name: 'Split at 1|3|1' }).click()

  let dialog = page.getByRole('dialog', { name: 'Notes cross this split' })
  await expect(dialog).toBeVisible()
  const description = await dialog.getByText(/notes? cross(?:es)? the cut/i).first().textContent()
  const affectedNotes = Number(description?.match(/(\d+)/)?.[1])
  expect(affectedNotes).toBeGreaterThanOrEqual(1)
  await expect(dialog.getByRole('button', { name: /Keep on left/ })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: /Shorten at cut/ })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: /Split notes/ })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Cancel MIDI split' }).click()

  await expect(page.getByRole('dialog', { name: 'Notes cross this split' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Variation 1 · MIDI, midi region/ })).toHaveCount(1)
  await expect(midiClip).toHaveAttribute('aria-label', originalClipLabel!)
  await expect(page.locator('.piano-note')).toHaveCount(originalNoteCount)

  await midiClip.click({ button: 'right' })
  menu = page.getByRole('menu', { name: 'Commands for Variation 1 · MIDI' })
  await menu.getByRole('menuitem', { name: 'Split at 1|3|1' }).click()
  dialog = page.getByRole('dialog', { name: 'Notes cross this split' })
  await dialog.getByRole('button', { name: /Split notes/ }).click()

  const left = page.getByRole('button', { name: /Variation 1 · MIDI A, midi region/ })
  const right = page.getByRole('button', { name: /Variation 1 · MIDI B, midi region/ })
  await expect(left).toBeVisible()
  await expect(right).toHaveAttribute('aria-label', /^Selected,/)
  await right.click()
  const rightNotes = await page.locator('.piano-note').count()
  await left.click()
  const leftNotes = await page.locator('.piano-note').count()
  expect(leftNotes + rightNotes).toBe(originalNoteCount + affectedNotes)
})

test('overlap prevention previews a collision and rejects pointer and keyboard commits', async ({ page }) => {
  await openStudio(page)
  const first = await generateAndPlace(page)
  const firstLabel = await first.getAttribute('aria-label')

  await first.click({ button: 'right' })
  await page.getByRole('menu', { name: 'Commands for Variation 1' }).getByRole('menuitem', { name: 'Duplicate after region' }).click()
  const copy = page.getByRole('button', { name: /Variation 1 copy, audio region/ })
  await expect(copy).toBeVisible()
  await first.click()

  const firstBox = await first.boundingBox()
  expect(firstBox).not.toBeNull()
  await page.mouse.move(firstBox!.x + firstBox!.width / 2, firstBox!.y + firstBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(firstBox!.x + firstBox!.width * 0.75, firstBox!.y + firstBox!.height / 2, { steps: 4 })
  const row = page.locator('.track-row').filter({ hasText: 'Generated audio' })
  await expect(row.locator('.track-lane')).toHaveClass(/is-invalid-drop-target/)
  await expect(row.locator('.track-lane')).toHaveAttribute('data-drop-label', 'OCCUPIED · MOVE BLOCKED')
  await expect(row.locator('.timeline-clip').filter({ has: first })).toHaveClass(/is-drop-collision/)
  await page.mouse.up()
  await expect(first).toHaveAttribute('aria-label', firstLabel!)

  await first.focus()
  await first.press('ArrowRight')
  await expect(first).toHaveAttribute('aria-label', firstLabel!)
  await expect(page.getByRole('status').filter({ hasText: /Edit blocked · Variation 1 copy already occupies that range/ })).toBeVisible()
  await expect(copy).toBeVisible()
})

test('mobile long-press opens the same command registry and loop controls keep 44px targets', async ({ page }) => {
  await openStudio(page)
  const audioClip = await generateAndPlace(page)
  await page.setViewportSize({ width: 390, height: 844 })

  const box = await audioClip.boundingBox()
  expect(box).not.toBeNull()
  const x = box!.x + box!.width / 2
  const y = box!.y + box!.height / 2
  await audioClip.dispatchEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    pointerId: 51,
    pointerType: 'touch',
    isPrimary: true,
    buttons: 1,
    clientX: x,
    clientY: y,
  })
  const menu = page.getByRole('menu', { name: 'Commands for Variation 1' })
  await expect(menu).toBeVisible({ timeout: 1_500 })
  await audioClip.dispatchEvent('pointerup', {
    bubbles: true,
    cancelable: true,
    pointerId: 51,
    pointerType: 'touch',
    isPrimary: true,
    buttons: 0,
    clientX: x,
    clientY: y,
  })
  expect(await commandIds(menu)).toEqual(AUDIO_COMMAND_IDS)
  await expectTouchTarget(menu.getByRole('menuitem', { name: 'Mute region' }))
  await menu.getByRole('menuitem', { name: 'Enable clip loop' }).click()

  const region = page.getByRole('group', { name: 'Variation 1 region controls' })
  await expect(region.locator('.clip-loop-notch')).toHaveCount(1)
  await expectTouchTarget(region.getByRole('button', { name: /Change source cycle end of Variation 1/ }))
  await expectTouchTarget(region.getByRole('button', { name: /Change clip loop extent of Variation 1/ }))
})
