import { expect, test, type Locator, type Page } from '@playwright/test'

test.use({ viewport: { width: 360, height: 800 }, hasTouch: true })

async function expectTouchTarget(locator: Locator) {
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  expect(box, 'touch target has a rendered box').not.toBeNull()
  expect(box!.width, 'touch target width').toBeGreaterThanOrEqual(44)
  expect(box!.height, 'touch target height').toBeGreaterThanOrEqual(44)
  return box!
}

async function expectAllTouchTargets(locator: Locator) {
  const sizes = await locator.evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect()
    return { width: box.width, height: box.height }
  }))
  expect(sizes.length).toBeGreaterThan(0)
  expect(sizes.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true)
}

async function pointerDrag(
  page: Page,
  locator: Locator,
  deltaX: number,
  deltaY: number,
  horizontalBias = 0.5,
) {
  const box = await expectTouchTarget(locator)
  const x = box.x + box.width * horizontalBias
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + deltaX, y + deltaY, { steps: 4 })
  await page.mouse.up()
}

test('mobile MIDI notes, resize handles, and velocity points expose real 44 px touch editing targets', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false')

  const surfaces = page.getByRole('navigation', { name: 'Studio surfaces' })
  await surfaces.getByRole('button', { name: 'Create', exact: true }).click()
  const source = page.locator('.source-panel')
  await source.getByLabel(/PROMPT/).fill('dry electric piano pulse, steady quarter notes, 120 BPM')
  await source.getByLabel('LENGTH').selectOption('seconds:4')
  await source.locator('.generation-controls').getByRole('button', { name: 'Generate', exact: true }).click()
  const candidate = source.locator('.candidate-card').filter({ hasText: 'Variation 1' })
  await expect(candidate).toBeVisible()
  await candidate.getByRole('button', { name: 'Place at playhead' }).click()
  await source.getByRole('button', { name: 'Close generator' }).click()

  await page.getByRole('button', { name: /Variation 1, audio region/ }).click()
  await page.locator('.mobile-context-bar').getByRole('button', { name: 'Extract MIDI' }).click()
  const midiClip = page.getByRole('button', { name: /Variation 1 · MIDI, midi region/ })
  await expect(midiClip).toBeVisible()
  await midiClip.click()
  await page.locator('.mobile-context-bar').getByRole('button', { name: 'Edit' }).click()

  await expectAllTouchTargets(page.locator('.note-move-touch-target'))
  await expectAllTouchTargets(page.locator('.velocity-touch-target'))
  // Use the final rendered note so its expanded target is the topmost target in
  // a deliberately dense fixture. Earlier targets are still measured by the
  // same CSS contract, while dense-note disambiguation remains a physical-device gate.
  const note = page.locator('.piano-note:not(.is-derived)').last()
  await expect(note).toBeVisible()
  const moveTarget = note.locator('.note-move-touch-target')
  // Playwright's supported trusted touchscreen API is tap-only. This tap proves
  // that the expanded target is hit by touch; the drag below exercises the same
  // production PointerEvent path with trusted mouse input.
  await moveTarget.tap()
  await expect(note).toHaveAttribute('aria-pressed', 'true')
  const selectedNote = page.locator('.piano-note.is-selected')
  await expect(selectedNote).toHaveCount(1)
  const beforeMove = await selectedNote.getAttribute('aria-label')
  await pointerDrag(page, moveTarget, -30, 0, 0.5)
  await expect.poll(() => selectedNote.getAttribute('aria-label')).not.toBe(beforeMove)

  const resizeTarget = selectedNote.locator('.note-resize-handle')
  const beforeResize = await selectedNote.getAttribute('aria-label')
  await resizeTarget.tap()
  await pointerDrag(page, resizeTarget, 28, 0)
  await expect.poll(() => selectedNote.getAttribute('aria-label')).not.toBe(beforeResize)

  const velocity = page.locator('.velocity-lane button.is-selected').first()
  const velocityTarget = velocity.locator('.velocity-touch-target')
  const beforeVelocity = await velocity.getAttribute('aria-valuenow')
  await velocityTarget.tap()
  await pointerDrag(page, velocityTarget, 0, -18)
  await expect.poll(() => velocity.getAttribute('aria-valuenow')).not.toBe(beforeVelocity)
})
