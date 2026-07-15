import { expect, test, type Locator, type Page } from '@playwright/test'

async function openStudio(page: Page) {
  await page.goto('/')
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('.arrangement-panel')).toBeVisible()
}

async function generateAndPlace(page: Page) {
  await page.getByLabel(/PROMPT/).fill('tight electric piano pulse, 120 BPM')
  await page.getByLabel('LENGTH').selectOption('seconds:4')
  await page.locator('.generation-controls').getByRole('button', { name: 'Generate', exact: true }).click()
  const candidate = page.locator('.candidate-card').filter({ hasText: 'Variation 1' })
  await expect(candidate).toBeVisible()
  await candidate.getByRole('button', { name: 'Place at playhead' }).click()
  await expect(page.getByRole('button', { name: /Variation 1, audio region/ })).toBeVisible()
}

async function addAudioTrack(page: Page) {
  await page.locator('.arrangement-heading').getByRole('button', { name: 'Add audio track', exact: true }).click()
}

async function trackOrder(rows: Locator) {
  return rows.evaluateAll((elements) => elements.map((element) => (element as HTMLElement).dataset.trackId))
}

async function expectTouchTarget(locator: Locator) {
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBeGreaterThanOrEqual(44)
  expect(box!.height).toBeGreaterThanOrEqual(44)
}

async function prepareCompatibleAndIncompatibleTracks(page: Page) {
  await generateAndPlace(page)
  await page.locator('.inspector-panel').getByRole('button', { name: 'Extract MIDI', exact: true }).click()
  await expect(page.getByRole('button', { name: /Variation 1 · MIDI, midi region/ })).toBeVisible()
  await addAudioTrack(page)

  const rows = page.locator('.track-row')
  await expect(rows).toHaveCount(3)
  const sourceRow = rows.filter({ hasText: 'Generated audio' })
  const incompatibleRow = rows.filter({ hasText: 'Extracted MIDI' })
  const targetRow = rows.filter({ hasText: 'New audio' })
  const audioClip = page.getByRole('button', { name: /Variation 1, audio region/ })
  await audioClip.click()
  return { sourceRow, incompatibleRow, targetRow, audioClip }
}

const regionStart = async (region: Locator) => {
  const label = await region.getAttribute('aria-label')
  const match = label?.match(/starts at beat ([\d.]+)/)
  expect(match, `region label exposes its start beat: ${label}`).not.toBeNull()
  return Number(match![1])
}

async function dispatchTouch(locator: Locator, type: 'pointerdown' | 'pointermove' | 'pointerup', pointerId: number, clientX: number, clientY: number) {
  await locator.dispatchEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId,
    pointerType: 'touch',
    isPrimary: true,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX,
    clientY,
  })
}

test('track reorder uses one undoable command and preserves region/detail selection on desktop and mobile', async ({ page }) => {
  await openStudio(page)
  await generateAndPlace(page)
  await addAudioTrack(page)
  await addAudioTrack(page)
  await page.getByRole('button', { name: /Variation 1, audio region/ }).click()

  const rows = page.locator('.track-row')
  await expect(rows).toHaveCount(3)
  const originalOrder = await trackOrder(rows)
  const generatedRow = rows.filter({ hasText: 'Generated audio' })
  const moveUp = generatedRow.getByRole('button', { name: 'Move Generated audio track up' })
  const moveDown = generatedRow.getByRole('button', { name: 'Move Generated audio track down' })
  await expect(moveUp).toBeDisabled()
  await expect(moveDown).toBeEnabled()
  await expect(rows.last().getByRole('button', { name: /Move .* track down/ })).toBeDisabled()

  await moveDown.focus()
  await moveDown.press('Enter')
  await expect.poll(() => trackOrder(rows)).toEqual([originalOrder[1], originalOrder[0], originalOrder[2]])
  await expect(page.locator('.detail-title h2')).toHaveText('Variation 1')
  await expect(page.getByRole('button', { name: /Selected, Variation 1, audio region/ })).toBeVisible()

  const desktopUndo = page.locator('.history-controls').getByRole('button', { name: 'Undo' })
  await desktopUndo.click()
  await expect.poll(() => trackOrder(rows)).toEqual(originalOrder)
  await expect(page.locator('.detail-title h2')).toHaveText('Variation 1')

  await page.setViewportSize({ width: 360, height: 800 })
  await page.getByRole('button', { name: 'Collapse detail editor' }).click()
  await expect(page.locator('.detail-panel')).toHaveCSS('display', 'none')
  const mobileGeneratedRow = rows.filter({ hasText: 'Generated audio' })
  const mobileMoveDown = mobileGeneratedRow.getByRole('button', { name: 'Move Generated audio track down' })
  await expectTouchTarget(mobileGeneratedRow.getByRole('button', { name: 'Move Generated audio track up' }))
  await expectTouchTarget(mobileMoveDown)
  await mobileMoveDown.click()
  await expect.poll(() => trackOrder(rows)).toEqual([originalOrder[1], originalOrder[0], originalOrder[2]])
  await expect(page.getByRole('button', { name: /Selected, Variation 1, audio region/ })).toBeVisible()

  await page.locator('.mobile-arrangement-actions').getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => trackOrder(rows)).toEqual(originalOrder)
})

test('two-pointer pinch and modified wheel preserve the beat beneath the centroid', async ({ page }) => {
  await openStudio(page)
  await generateAndPlace(page)

  const scroll = page.locator('.arrangement-scroll')
  const stage = page.locator('.timeline-stage')
  const bounds = await scroll.boundingBox()
  const headerWidth = await page.locator('.ruler-corner').evaluate((element) => element.getBoundingClientRect().width)
  expect(bounds).not.toBeNull()
  const centroidX = bounds!.x + headerWidth + (bounds!.width - headerWidth) * 0.55
  const centerY = bounds!.y + Math.min(110, bounds!.height / 2)

  const beatAtCentroid = async () => scroll.evaluate((element, clientX) => {
    const content = element.querySelector<HTMLElement>('.timeline-stage')!
    const header = element.querySelector<HTMLElement>('.ruler-corner')!
    const viewport = element.getBoundingClientRect()
    const contentWidth = content.getBoundingClientRect().width
    const fixedHeaderWidth = header.getBoundingClientRect().width
    const timelineBeats = Number(element.querySelector<HTMLElement>('.timeline-ruler')?.dataset.timelineBeats)
    return ((element.scrollLeft + clientX - viewport.left - fixedHeaderWidth) / (contentWidth - fixedHeaderWidth)) * timelineBeats
  }, centroidX)

  const beforeBeat = await beatAtCentroid()
  await scroll.dispatchEvent('pointerdown', { pointerId: 41, pointerType: 'touch', isPrimary: true, buttons: 1, clientX: centroidX - 60, clientY: centerY })
  await scroll.dispatchEvent('pointerdown', { pointerId: 42, pointerType: 'touch', isPrimary: false, buttons: 1, clientX: centroidX + 60, clientY: centerY })
  await scroll.dispatchEvent('pointermove', { pointerId: 41, pointerType: 'touch', isPrimary: true, buttons: 1, clientX: centroidX - 120, clientY: centerY })
  await scroll.dispatchEvent('pointermove', { pointerId: 42, pointerType: 'touch', isPrimary: false, buttons: 1, clientX: centroidX + 120, clientY: centerY })

  const zoom = page.getByLabel('Timeline zoom')
  await expect.poll(async () => Number(await zoom.inputValue())).toBeCloseTo(2, 2)
  await expect.poll(async () => {
    const afterBeat = await beatAtCentroid()
    const timelineWidth = await stage.evaluate((element, width) => element.getBoundingClientRect().width - width, headerWidth)
    const timelineBeats = Number(await page.locator('.timeline-ruler').getAttribute('data-timeline-beats'))
    return Math.abs(afterBeat - beforeBeat) * (timelineWidth / timelineBeats)
  }).toBeLessThanOrEqual(1)
  await expect(page.locator('.detail-title h2')).toHaveText('Variation 1')
  await expect(page.getByRole('button', { name: /Selected, Variation 1, audio region/ })).toBeVisible()

  await scroll.dispatchEvent('pointerup', { pointerId: 41, pointerType: 'touch', isPrimary: true, buttons: 0, clientX: centroidX - 120, clientY: centerY })
  await scroll.dispatchEvent('pointerup', { pointerId: 42, pointerType: 'touch', isPrimary: false, buttons: 0, clientX: centroidX + 120, clientY: centerY })

  const ordinaryWheelPrevented = await scroll.evaluate((element, clientX) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX, deltaY: 40 })
    element.dispatchEvent(event)
    return event.defaultPrevented
  }, centroidX)
  expect(ordinaryWheelPrevented).toBe(false)

  const beforeWheelZoom = Number(await zoom.inputValue())
  const modifiedWheelPrevented = await scroll.evaluate((element, clientX) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX, deltaY: -40, ctrlKey: true })
    element.dispatchEvent(event)
    return event.defaultPrevented
  }, centroidX)
  expect(modifiedWheelPrevented).toBe(true)
  await expect.poll(async () => Number(await zoom.inputValue())).toBeGreaterThan(beforeWheelZoom)

  const beforeButtonZoom = Number(await zoom.inputValue())
  await page.locator('.zoom-control').getByRole('button', { name: '+' }).click()
  await expect.poll(async () => Number(await zoom.inputValue())).toBeGreaterThan(beforeButtonZoom)
  await expect(page.locator('.detail-title h2')).toHaveText('Variation 1')
})

test('blank lanes select without seeking and keyboard movement skips incompatible tracks', async ({ page }) => {
  await openStudio(page)
  const { sourceRow, targetRow, audioClip } = await prepareCompatibleAndIncompatibleTracks(page)
  const playhead = page.getByRole('slider', { name: 'Arrangement playhead' })

  const playheadBeforeLaneClick = await playhead.getAttribute('aria-valuenow')
  const sourceLane = sourceRow.locator('.track-lane')
  const laneBox = await sourceLane.boundingBox()
  expect(laneBox).not.toBeNull()
  await page.mouse.click(laneBox!.x + laneBox!.width * 0.82, laneBox!.y + laneBox!.height / 2)
  await expect(playhead).toHaveAttribute('aria-valuenow', playheadBeforeLaneClick!)
  await expect(page.locator('.status-bar')).toContainText('Track · Generated audio')
  await expect(page.getByRole('button', { name: /Selected, Variation 1, audio region/ })).toHaveCount(0)

  const ruler = page.locator('.timeline-ruler')
  const rulerBox = await ruler.boundingBox()
  expect(rulerBox).not.toBeNull()
  await page.mouse.click(rulerBox!.x + rulerBox!.width * 0.7, rulerBox!.y + rulerBox!.height / 2)
  await expect.poll(async () => Number(await playhead.getAttribute('aria-valuenow'))).toBeGreaterThan(20)

  await audioClip.focus()
  await expect(audioClip).toHaveAttribute('aria-describedby', 'arrangement-clip-keyboard-help')
  await expect(audioClip).toHaveAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown Enter Shift+F10')
  await audioClip.press('Alt+ArrowDown')
  await expect(targetRow.getByRole('button', { name: /Selected, Variation 1, audio region/ })).toBeVisible()
  await expect(sourceRow.getByRole('button', { name: /Variation 1, audio region/ })).toHaveCount(0)

  await page.locator('.history-controls').getByRole('button', { name: 'Undo' }).click()
  const restored = sourceRow.getByRole('button', { name: /Selected, Variation 1, audio region/ })
  await expect(restored).toBeVisible()
  await restored.focus()
  await restored.press('Enter')
  await expect(page.locator('.app-shell')).toHaveClass(/mobile-surface-detail/)
  await expect(page.locator('.detail-title h2')).toHaveText('Variation 1')

  await page.setViewportSize({ width: 360, height: 800 })
  await page.getByRole('navigation', { name: 'Studio surfaces' }).getByRole('button', { name: 'Arrange', exact: true }).click()
  await expect(page.locator('.detail-panel')).toHaveCSS('display', 'none')
  await restored.dblclick()
  await expect(page.locator('.detail-panel')).toHaveCSS('display', 'flex')
})

test('body drag previews invalid and valid lanes, then commits timing and track as one undo item', async ({ page }) => {
  await openStudio(page)
  const { sourceRow, incompatibleRow, targetRow, audioClip } = await prepareCompatibleAndIncompatibleTracks(page)
  const initialStart = await regionStart(audioClip)
  const bodyBox = await audioClip.boundingBox()
  const incompatibleBox = await incompatibleRow.locator('.track-lane').boundingBox()
  expect(bodyBox).not.toBeNull()
  expect(incompatibleBox).not.toBeNull()

  await page.mouse.move(bodyBox!.x + bodyBox!.width / 2, bodyBox!.y + bodyBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(bodyBox!.x + bodyBox!.width / 2 + 45, incompatibleBox!.y + incompatibleBox!.height / 2, { steps: 4 })
  await expect(incompatibleRow.locator('.track-lane')).toHaveClass(/is-invalid-drop-target/)
  await expect(incompatibleRow.locator('.track-lane')).toHaveAttribute('data-drop-label', /NOT ALLOWED/)
  await expect(sourceRow.locator('.timeline-clip')).toHaveClass(/is-drop-invalid/)
  await page.mouse.up()
  await expect(sourceRow.getByRole('button', { name: /Selected, Variation 1, audio region/ })).toBeVisible()
  expect(await regionStart(audioClip)).toBe(initialStart)

  const targetBox = await targetRow.locator('.track-lane').boundingBox()
  const restoredBox = await audioClip.boundingBox()
  expect(targetBox).not.toBeNull()
  expect(restoredBox).not.toBeNull()
  await page.mouse.move(restoredBox!.x + restoredBox!.width / 2, restoredBox!.y + restoredBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(restoredBox!.x + restoredBox!.width / 2 + 36, targetBox!.y + targetBox!.height / 2, { steps: 3 })
  await expect(targetRow.locator('.track-lane')).toHaveClass(/is-valid-drop-target/)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(sourceRow.getByRole('button', { name: /Selected, Variation 1, audio region/ })).toBeVisible()
  expect(await regionStart(audioClip)).toBe(initialStart)

  await page.mouse.move(restoredBox!.x + restoredBox!.width / 2, restoredBox!.y + restoredBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(restoredBox!.x + restoredBox!.width / 2 + 72, targetBox!.y + targetBox!.height / 2, { steps: 5 })
  await expect(targetRow.locator('.track-lane')).toHaveClass(/is-valid-drop-target/)
  await expect(targetRow.locator('.track-lane')).toHaveAttribute('data-drop-label', 'MOVE TO New audio')
  await expect(sourceRow.locator('.timeline-clip')).toHaveClass(/is-drop-valid/)
  await page.mouse.up()

  const moved = targetRow.getByRole('button', { name: /Selected, Variation 1, audio region/ })
  await expect(moved).toBeVisible()
  const movedStart = await regionStart(moved)
  expect(movedStart).toBeGreaterThan(initialStart)
  await expect(sourceRow.getByRole('button', { name: /Variation 1, audio region/ })).toHaveCount(0)

  await page.locator('.history-controls').getByRole('button', { name: 'Undo' }).click()
  const restored = sourceRow.getByRole('button', { name: /Selected, Variation 1, audio region/ })
  await expect(restored).toBeVisible()
  expect(await regionStart(restored)).toBe(initialStart)
  await expect(targetRow.getByRole('button', { name: /Variation 1, audio region/ })).toHaveCount(0)
})

test('selected touch regions transfer tracks and a deliberate double tap opens Detail', async ({ page }) => {
  await openStudio(page)
  const { sourceRow, targetRow, audioClip } = await prepareCompatibleAndIncompatibleTracks(page)
  await page.setViewportSize({ width: 360, height: 800 })
  const scroll = page.locator('.arrangement-scroll')
  const clipBox = await audioClip.boundingBox()
  const targetBox = await targetRow.locator('.track-lane').boundingBox()
  expect(clipBox).not.toBeNull()
  expect(targetBox).not.toBeNull()

  await dispatchTouch(audioClip, 'pointerdown', 71, clipBox!.x + clipBox!.width / 2, clipBox!.y + clipBox!.height / 2)
  await page.waitForTimeout(30)
  await dispatchTouch(scroll, 'pointermove', 71, clipBox!.x + clipBox!.width / 2 + 36, targetBox!.y + targetBox!.height / 2)
  await expect(targetRow.locator('.track-lane')).toHaveClass(/is-valid-drop-target/)
  await dispatchTouch(scroll, 'pointerup', 71, clipBox!.x + clipBox!.width / 2 + 36, targetBox!.y + targetBox!.height / 2)

  const moved = targetRow.getByRole('button', { name: /Selected, Variation 1, audio region/ })
  await expect(moved).toBeVisible()
  await expect(sourceRow.getByRole('button', { name: /Variation 1, audio region/ })).toHaveCount(0)
  const movedBox = await moved.boundingBox()
  expect(movedBox).not.toBeNull()
  const tapX = movedBox!.x + movedBox!.width / 2
  const tapY = movedBox!.y + movedBox!.height / 2

  await dispatchTouch(moved, 'pointerdown', 72, tapX, tapY)
  await page.waitForTimeout(20)
  await dispatchTouch(moved, 'pointerup', 72, tapX, tapY)
  await page.waitForTimeout(30)
  await dispatchTouch(moved, 'pointerdown', 73, tapX, tapY)
  await page.waitForTimeout(20)
  await dispatchTouch(moved, 'pointerup', 73, tapX, tapY)
  await expect(page.locator('.detail-panel')).toHaveCSS('display', 'flex')
  await expect(page.locator('.detail-title h2')).toHaveText('Variation 1')
})
