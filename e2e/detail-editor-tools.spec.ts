import { expect, test, type Locator, type Page } from '@playwright/test'

const PIANO_ROW_HEIGHT = 12

async function openExtractedMidiDetail(page: Page) {
  await page.goto('/')
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false')

  const source = page.getByLabel('Sound source')
  await source.getByLabel(/PROMPT/).fill('steady electric piano notes, dry pulse, 120 BPM')
  await source.getByLabel('LENGTH').selectOption('seconds:4')
  await source.locator('.generation-controls').getByRole('button', { name: 'Generate', exact: true }).click()

  const candidate = source.locator('.candidate-card').filter({ hasText: 'Variation 1' })
  await expect(candidate).toBeVisible()
  await candidate.getByRole('button', { name: 'Place at playhead' }).click()

  const audioRegion = page.getByRole('button', { name: /Variation 1, audio region/ })
  await expect(audioRegion).toBeVisible()
  await page.getByLabel('Selected region inspector').getByRole('button', { name: 'Extract MIDI', exact: true }).click()

  const midiRegion = page.getByRole('button', { name: /Variation 1 · MIDI, midi region/ })
  await expect(midiRegion).toBeVisible()
  await midiRegion.click()

  const detail = page.getByRole('region', { name: 'Detail editor' })
  const pianoRoll = detail.getByRole('group', { name: 'MIDI piano roll' })
  const notes = pianoRoll.locator('.piano-note[role="button"]:not(.is-derived)')
  await expect(notes.first()).toBeVisible()
  return { detail, midiRegion, notes, pianoRoll }
}

function regionDuration(label: string | null) {
  const match = label?.match(/duration ([\d.]+) beats/)
  expect(match, `MIDI region duration must be exposed in ${label ?? '<missing aria-label>'}`).not.toBeNull()
  return Number(match![1])
}

async function setPitchWindow(page: Page, pitch: number) {
  await page.locator('.piano-roll-wrap').evaluate((element, targetPitch) => {
    const rowTop = (127 - targetPitch) * 12
    element.scrollTop = Math.max(0, rowTop - 120)
  }, pitch)
}

async function gridPoint(grid: Locator, clipDuration: number, beat: number, pitch: number) {
  const box = await grid.boundingBox()
  expect(box, 'piano roll must have a rendered editing surface').not.toBeNull()
  return {
    x: box!.x + (beat / clipDuration) * box!.width,
    y: box!.y + (127 - pitch + 0.5) * PIANO_ROW_HEIGHT,
  }
}

async function drawNote(page: Page, grid: Locator, clipDuration: number, beat: number, pitch: number) {
  const point = await gridPoint(grid, clipDuration, beat, pitch)
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.up()
}

async function pointerClick(page: Page, target: Locator) {
  const box = await target.boundingBox()
  expect(box, 'pointer target must have a rendered box').not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.up()
}

async function selectedNoteLabels(detail: Locator) {
  return detail.locator('.piano-note.is-selected[role="button"]').evaluateAll((notes) => (
    notes.map((note) => note.getAttribute('aria-label') ?? '')
  ))
}

test('piano-roll tools, grouped edits, key selection, audition hit testing, and fixed geometry work end to end', async ({ page }) => {
  const { detail, midiRegion, notes, pianoRoll } = await openExtractedMidiDetail(page)
  const duration = regionDuration(await midiRegion.getAttribute('aria-label'))
  expect(duration).toBeGreaterThan(5)

  const toolbar = detail.getByRole('toolbar', { name: 'Piano roll editing mode' })
  const drawTool = toolbar.getByRole('button', { name: 'Draw notes' })
  const selectTool = toolbar.getByRole('button', { name: 'Range select notes' })
  const eraseTool = toolbar.getByRole('button', { name: 'Erase notes' })
  await expect(selectTool).toHaveAttribute('aria-pressed', 'true')
  await expect(drawTool).toHaveAttribute('aria-pressed', 'false')
  await expect(eraseTool).toHaveAttribute('aria-pressed', 'false')

  const firstNote = notes.first()
  const collapsedNoteHeight = await firstNote.evaluate((note) => note.getBoundingClientRect().height)
  await detail.getByRole('button', { name: 'Expand detail editor', exact: true }).click()
  await expect(detail.getByRole('button', { name: 'Restore detail editor', exact: true })).toBeVisible()
  const expandedNoteHeight = await firstNote.evaluate((note) => note.getBoundingClientRect().height)
  expect(collapsedNoteHeight).toBeCloseTo(PIANO_ROW_HEIGHT, 4)
  expect(expandedNoteHeight).toBeCloseTo(collapsedNoteHeight, 4)

  const noteInspector = detail.getByRole('region', { name: 'Selected note inspector' })
  const quantize = detail.locator('.midi-quantize-controls')
  const [inspectorBox, quantizeBox] = await Promise.all([noteInspector.boundingBox(), quantize.boundingBox()])
  expect(inspectorBox).not.toBeNull()
  expect(quantizeBox).not.toBeNull()
  expect(quantizeBox!.y).toBeGreaterThanOrEqual(inspectorBox!.y + inspectorBox!.height)
  expect(quantizeBox!.y - (inspectorBox!.y + inspectorBox!.height)).toBeLessThanOrEqual(12)
  expect(await quantize.locator(':scope > *').evaluateAll((children) => children.map((child) => child.textContent?.trim() ?? ''))).toEqual([
    expect.stringContaining('QUANTIZE'),
    expect.stringContaining('STRENGTH'),
    expect.stringContaining('Apply quantize'),
  ])

  const undo = page.locator('.history-controls').getByRole('button', { name: 'Undo' })
  const extractedNoteCount = await notes.count()
  expect(extractedNoteCount).toBeGreaterThan(1)

  // A multi-delete is one application transaction: one Undo restores every
  // source note rather than only the last callback in a loop.
  await pianoRoll.focus()
  await pianoRoll.press('Control+A')
  await expect(noteInspector.getByText(`${extractedNoteCount} selected`, { exact: true })).toBeVisible()
  await pianoRoll.press('Delete')
  await expect(notes).toHaveCount(0)
  await undo.click()
  await expect(notes).toHaveCount(extractedNoteCount)

  // Clear the fixture notes again, then use only the visible editing controls
  // to build a deterministic phrase for the remaining interaction checks.
  await pianoRoll.focus()
  await pianoRoll.press('Control+A')
  await pianoRoll.press('Delete')
  await expect(notes).toHaveCount(0)
  await setPitchWindow(page, 62)

  await drawTool.click()
  await expect(drawTool).toHaveAttribute('aria-pressed', 'true')
  const phrase = [
    { beat: 0.5, pitch: 60 },
    { beat: 1.5, pitch: 60 },
    { beat: 2.5, pitch: 62 },
    { beat: 3.5, pitch: 64 },
    { beat: 4.5, pitch: 65 },
  ]
  for (const [index, note] of phrase.entries()) {
    await drawNote(page, pianoRoll, duration, note.beat, note.pitch)
    await expect(notes).toHaveCount(index + 1)
  }
  const firstC = pianoRoll.getByRole('button', { name: /^C4, starts at 0\.50 beats/ })
  const secondC = pianoRoll.getByRole('button', { name: /^C4, starts at 1\.50 beats/ })
  const d = pianoRoll.getByRole('button', { name: /^D4, starts at 2\.50 beats/ })
  const e = pianoRoll.getByRole('button', { name: /^E4, starts at 3\.50 beats/ })
  const extraF = pianoRoll.getByRole('button', { name: /^F4, starts at 4\.50 beats/ })
  await expect(firstC).toBeVisible()
  await expect(secondC).toBeVisible()
  await expect(d).toBeVisible()

  // Pencil protects an unfocused source note from an accidental delete: the
  // first stationary click only selects/focuses it. A second stationary click
  // on that already-selected note deletes it, and one Undo restores it.
  await pointerClick(page, extraF)
  await expect(notes).toHaveCount(5)
  await expect(extraF).toHaveAttribute('aria-pressed', 'true')
  await expect(noteInspector.getByText('1 selected', { exact: true })).toBeVisible()
  await pointerClick(page, extraF)
  await expect(notes).toHaveCount(4)
  await undo.click()
  await expect(notes).toHaveCount(5)

  // Eraser gathers every source note crossed by one drag and commits only at
  // pointer-up. One Undo restores the entire stroke, proving it was atomic.
  await eraseTool.click()
  await expect(eraseTool).toHaveAttribute('aria-pressed', 'true')
  const [eBox, fBox] = await Promise.all([
    e.boundingBox(),
    pianoRoll.getByRole('button', { name: /^F4, starts at 4\.50 beats/ }).boundingBox(),
  ])
  expect(eBox).not.toBeNull()
  expect(fBox).not.toBeNull()
  await page.mouse.move(eBox!.x + eBox!.width / 2, eBox!.y + eBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(fBox!.x + fBox!.width / 2, fBox!.y + fBox!.height / 2, { steps: 10 })
  await expect(notes).toHaveCount(5)
  await page.mouse.up()
  await expect(notes).toHaveCount(3)
  await undo.click()
  await expect(notes).toHaveCount(5)

  // Remove only the throwaway F4 with the same select-then-delete Pencil
  // contract, leaving the four-note phrase used by the assertions below.
  await drawTool.click()
  await expect(drawTool).toHaveAttribute('aria-pressed', 'true')
  const restoredF = pianoRoll.getByRole('button', { name: /^F4, starts at 4\.50 beats/ })
  await pointerClick(page, restoredF)
  await expect(notes).toHaveCount(5)
  await expect(restoredF).toHaveAttribute('aria-pressed', 'true')
  await pointerClick(page, restoredF)
  await expect(notes).toHaveCount(4)
  await selectTool.click()
  await expect(selectTool).toHaveAttribute('aria-pressed', 'true')

  // Source Length owns ArrowDown explicitly instead of relying on the browser's
  // number-input stepping. The same selected note gets a distinct velocity so
  // the later batch inspector genuinely starts from mixed data.
  await firstC.click()
  const sourceLength = detail.getByLabel('Selected note duration beats')
  await expect(sourceLength).toHaveValue('0.5')
  await sourceLength.press('ArrowDown')
  await expect(sourceLength).toHaveValue('0.25')
  await expect(firstC).toHaveAttribute('aria-label', /duration 0\.25 beats/)
  const singleVelocity = detail.getByLabel('Selected note velocity')
  await singleVelocity.press('ArrowDown')
  await expect(firstC).toHaveAttribute('aria-label', /velocity 94/)

  // With one source note selected, Pencil resolves its right edge as resize,
  // not body-delete or body-move. The source note count stays unchanged and a
  // single Undo restores the prior length.
  await drawTool.click()
  const pencilResize = firstC.locator('.note-resize-handle')
  await expect(pencilResize).toBeVisible()
  const [resizeBox, resizeGridBox] = await Promise.all([pencilResize.boundingBox(), pianoRoll.boundingBox()])
  expect(resizeBox).not.toBeNull()
  expect(resizeGridBox).not.toBeNull()
  await page.mouse.move(resizeBox!.x + resizeBox!.width / 2, resizeBox!.y + resizeBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    resizeBox!.x + resizeBox!.width / 2 + (0.25 / duration) * resizeGridBox!.width,
    resizeBox!.y + resizeBox!.height / 2,
    { steps: 5 },
  )
  await page.mouse.up()
  await expect(notes).toHaveCount(4)
  await expect(firstC).toHaveAttribute('aria-label', /duration 0\.50 beats/)
  await undo.click()
  await expect(firstC).toHaveAttribute('aria-label', /duration 0\.25 beats/)
  await selectTool.click()

  // Marquee across the two C4 source notes, starting on guaranteed blank grid
  // space so the interaction cannot accidentally become a note drag.
  const gridBox = await pianoRoll.boundingBox()
  expect(gridBox).not.toBeNull()
  const c4Top = gridBox!.y + (127 - 60) * PIANO_ROW_HEIGHT
  const marqueeStart = {
    x: gridBox!.x + (0.25 / duration) * gridBox!.width,
    y: c4Top - 2,
  }
  const marqueeEnd = {
    x: gridBox!.x + (2.25 / duration) * gridBox!.width,
    y: c4Top + PIANO_ROW_HEIGHT + 2,
  }
  await page.mouse.move(marqueeStart.x, marqueeStart.y)
  await page.mouse.down()
  await page.mouse.move(marqueeEnd.x, marqueeEnd.y, { steps: 5 })
  await expect(detail.locator('.piano-selection-marquee')).toBeVisible()
  await page.mouse.up()
  await expect(noteInspector.getByText('2 selected', { exact: true })).toBeVisible()
  await expect(detail.locator('.piano-note.is-selected[role="button"]')).toHaveCount(2)

  // The same Pencil body that deletes on a stationary click becomes a move
  // after the drag threshold. Because both C4 notes are selected, the body drag
  // previews and commits one group move while preserving the note count.
  await drawTool.click()
  const selectedAnchorBox = await firstC.boundingBox()
  expect(selectedAnchorBox).not.toBeNull()
  await page.mouse.move(selectedAnchorBox!.x + selectedAnchorBox!.width / 2, selectedAnchorBox!.y + selectedAnchorBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    selectedAnchorBox!.x + selectedAnchorBox!.width / 2 + (0.25 / duration) * gridBox!.width,
    selectedAnchorBox!.y + selectedAnchorBox!.height / 2 - PIANO_ROW_HEIGHT,
    { steps: 6 },
  )
  await page.mouse.up()
  await expect(notes).toHaveCount(4)
  await expect.poll(() => selectedNoteLabels(detail)).toEqual([
    expect.stringMatching(/^C♯4, starts at 0\.75 beats/),
    expect.stringMatching(/^C♯4, starts at 1\.75 beats/),
  ])
  await undo.click()
  await expect.poll(() => selectedNoteLabels(detail)).toEqual([
    expect.stringMatching(/^C4, starts at 0\.50 beats/),
    expect.stringMatching(/^C4, starts at 1\.50 beats/),
  ])
  await selectTool.click()

  // A relative Pitch edit commits one batch. Both notes move, and one Undo
  // restores both, proving that the UI did not emit independent history edits.
  const pitch = detail.getByLabel('Selected note pitch')
  await expect(pitch).toHaveValue('60')
  await pitch.press('ArrowUp')
  await expect.poll(() => selectedNoteLabels(detail)).toEqual([
    expect.stringMatching(/^C♯4,/),
    expect.stringMatching(/^C♯4,/),
  ])
  await undo.click()
  await expect.poll(() => selectedNoteLabels(detail)).toEqual([
    expect.stringMatching(/^C4,/),
    expect.stringMatching(/^C4,/),
  ])

  await pianoRoll.focus()
  await pianoRoll.press('Delete')
  await expect(notes).toHaveCount(2)
  await undo.click()
  await expect(notes).toHaveCount(4)

  // Piano-key double click selects every source note at that pitch; Shift adds
  // another pitch without losing the existing pitch selection.
  const cKey = detail.getByRole('button', { name: 'Audition C4', exact: true })
  const dKey = detail.getByRole('button', { name: 'Audition D4', exact: true })
  await cKey.dblclick()
  await expect(noteInspector.getByText('2 selected', { exact: true })).toBeVisible()
  await dKey.dblclick({ modifiers: ['Shift'] })
  await expect(noteInspector.getByText('3 selected', { exact: true })).toBeVisible()

  const batchPitch = detail.getByLabel('Selected note pitch')
  const batchLength = detail.getByLabel('Selected note duration beats')
  const batchVelocity = detail.getByLabel('Selected note velocity')
  await expect(batchPitch).toHaveValue('')
  await expect(batchPitch).toHaveAttribute('placeholder', 'MIXED')
  await expect(batchLength).toHaveValue('')
  await expect(batchLength).toHaveAttribute('placeholder', 'MIXED')
  await expect(batchVelocity).toHaveAttribute('aria-valuetext', 'Mixed velocities')

  await batchPitch.fill('70')
  await expect.poll(() => selectedNoteLabels(detail)).toEqual([
    expect.stringMatching(/^A♯4,/),
    expect.stringMatching(/^A♯4,/),
    expect.stringMatching(/^A♯4,/),
  ])
  await batchLength.fill('1')
  await expect.poll(async () => (await selectedNoteLabels(detail)).map((label) => /duration 1\.00 beats/.test(label))).toEqual([true, true, true])
  await batchVelocity.press('ArrowRight')
  await expect(batchVelocity).toHaveAttribute('aria-valuetext', '65 of 127')
  await expect.poll(async () => (await selectedNoteLabels(detail)).map((label) => /velocity 65/.test(label))).toEqual([true, true, true])

  // The black-key shape visibly extends into the preceding white-key row. Hit
  // that upper shape (outside the button's layout box) and prove the black key,
  // not the white key beneath it, owns focus and produces audible meter output.
  const blackKey = detail.getByRole('button', { name: 'Audition C♯4', exact: true })
  await expect(blackKey).toBeVisible()
  const blackGeometry = await blackKey.evaluate((key) => {
    const box = key.getBoundingClientRect()
    const shape = getComputedStyle(key, '::after')
    return {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      shapeWidth: Number.parseFloat(shape.width),
      shapeHeight: Number.parseFloat(shape.height),
    }
  })
  expect(blackGeometry.shapeHeight).toBeGreaterThan(blackGeometry.height * 0.7)
  const blackShapePoint = {
    x: blackGeometry.x + blackGeometry.shapeWidth / 2,
    y: blackGeometry.y - Math.min(2, blackGeometry.shapeHeight / 4),
  }
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('aria-label'), blackShapePoint)).toBe('Audition C♯4')

  const midiMeter = page.getByRole('meter', { name: 'Extracted MIDI peak level' })
  await page.mouse.move(blackShapePoint.x, blackShapePoint.y)
  await page.mouse.down()
  try {
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Audition C♯4')
    await expect.poll(async () => Number(await midiMeter.getAttribute('aria-valuenow')), {
      timeout: 3_000,
      intervals: [20, 50, 100],
    }).toBeGreaterThan(0)
  } finally {
    await page.mouse.up()
  }
})
