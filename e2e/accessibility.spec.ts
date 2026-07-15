import { expect, test, type Locator, type Page } from '@playwright/test'

const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="slider"]',
].join(',')

async function openStudio(page: Page) {
  await page.goto('/')
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('.arrangement-panel')).toBeVisible()
}

async function expectTouchTarget(locator: Locator) {
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  expect(box, 'touch target has a rendered box').not.toBeNull()
  expect(box!.width, 'touch target width').toBeGreaterThanOrEqual(44)
  expect(box!.height, 'touch target height').toBeGreaterThanOrEqual(44)
}

async function expectNoNestedInteractiveControls(page: Page) {
  const violations = await page.evaluate((selector) => {
    const visible = (element: Element) => {
      const html = element as HTMLElement
      const style = window.getComputedStyle(html)
      return style.display !== 'none' && style.visibility !== 'hidden' && html.getClientRects().length > 0
    }
    return [...document.querySelectorAll(selector)]
      .filter(visible)
      .flatMap((element) => {
        const ancestor = element.parentElement?.closest(selector)
        if (!ancestor || !visible(ancestor)) return []
        return [`${ancestor.tagName.toLowerCase()} contains ${element.tagName.toLowerCase()}`]
      })
  }, INTERACTIVE_SELECTOR)
  expect(violations).toEqual([])
}

async function expectVisibleControlsNamed(page: Page) {
  const unnamed = await page.evaluate((selector) => {
    const visible = (element: HTMLElement) => {
      const style = window.getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
    }
    const labelText = (element: HTMLElement) => {
      const labelledBy = element.getAttribute('aria-labelledby')
      const referenced = labelledBy
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
        .join(' ')
        .trim()
      const explicitLabel = element.id
        ? document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(element.id)}"]`)?.innerText.trim()
        : ''
      const wrappingLabel = element.closest('label')?.innerText.trim()
      return element.getAttribute('aria-label')?.trim()
        || referenced
        || explicitLabel
        || wrappingLabel
        || element.innerText.trim()
        || element.getAttribute('title')?.trim()
        || ''
    }
    return [...document.querySelectorAll<HTMLElement>(selector)]
      .filter(visible)
      .filter((element) => !labelText(element))
      .map((element) => element.outerHTML.slice(0, 180))
  }, `${INTERACTIVE_SELECTOR}, [role="meter"], [role="progressbar"]`)
  expect(unnamed).toEqual([])
}

const relativeLuminance = (hex: string) => {
  const channels = hex.match(/[\da-f]{2}/gi)?.map((value) => Number.parseInt(value, 16) / 255) ?? []
  const [red, green, blue] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

const contrastRatio = (foreground: string, background: string) => {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (light + 0.05) / (dark + 0.05)
}

test('desktop controls have truthful semantics, visible focus, contrast, and a trapped dismissible engine dialog', async ({ page }) => {
  await openStudio(page)

  await expectNoNestedInteractiveControls(page)
  await expectVisibleControlsNamed(page)
  await expect(page.locator('.source-panel .close-panel')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Toggle loop', exact: true }).first()).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByRole('button', { name: 'Toggle snap, 1/16 grid' }).first()).toHaveAttribute('aria-pressed', 'true')

  const contrast = await page.evaluate(() => {
    const root = window.getComputedStyle(document.documentElement)
    return {
      faint: root.getPropertyValue('--text-faint').trim(),
      dim: root.getPropertyValue('--text-dim').trim(),
      darkestPanel: root.getPropertyValue('--ink-3').trim(),
    }
  })
  expect(contrastRatio(contrast.faint, contrast.darkestPanel)).toBeGreaterThanOrEqual(4.5)
  expect(contrastRatio(contrast.dim, contrast.darkestPanel)).toBeGreaterThanOrEqual(4.5)

  const addTrack = page.locator('.arrangement-heading').getByRole('button', { name: 'Add audio track' })
  await addTrack.focus()
  await expect(addTrack).toBeFocused()
  const focusStyle = await addTrack.evaluate((element) => {
    const style = window.getComputedStyle(element)
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) }
  })
  expect(focusStyle.style).not.toBe('none')
  expect(focusStyle.width).toBeGreaterThanOrEqual(2)

  const engineButton = page.getByRole('button', { name: 'Engine settings', exact: true })
  await engineButton.click()
  const dialog = page.getByRole('dialog', { name: 'Inference readiness' })
  await expect(dialog).toBeVisible()
  const close = dialog.getByRole('button', { name: 'Close engine settings' })
  const done = dialog.getByRole('button', { name: 'Done' })
  await expect(close).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(done).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(close).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(engineButton).toBeFocused()

  await page.emulateMedia({ reducedMotion: 'reduce' })
  const transitionMilliseconds = await page.locator('.timeline-stage').evaluate((element) => {
    const seconds = Number.parseFloat(window.getComputedStyle(element).transitionDuration)
    return seconds * 1_000
  })
  expect(transitionMilliseconds).toBeLessThanOrEqual(0.1)
})

test('mobile navigation, source dismissal, loop/trim editing, and primary controls meet 44 px target contract', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 })
  await openStudio(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)

  const surfaces = page.getByRole('navigation', { name: 'Studio surfaces' })
  const arrange = surfaces.getByRole('button', { name: 'Arrange', exact: true })
  const create = surfaces.getByRole('button', { name: 'Create', exact: true })
  const mix = surfaces.getByRole('button', { name: 'Mix', exact: true })
  await expect(arrange).toHaveAttribute('aria-current', 'page')
  await expectTouchTarget(arrange)
  await expectTouchTarget(create)
  await expectTouchTarget(mix)
  await expectTouchTarget(page.getByRole('button', { name: 'Play', exact: true }))
  await expectTouchTarget(page.getByRole('button', { name: 'Stop', exact: true }))
  await expectTouchTarget(page.getByRole('slider', { name: 'Arrangement playhead' }))
  await expectTouchTarget(page.locator('.arrangement-heading').getByRole('button', { name: 'Add audio track' }))

  await create.click()
  await expect(create).toHaveAttribute('aria-current', 'page')
  const source = page.locator('.source-panel')
  await expect(source).toHaveCSS('display', 'grid')
  const closeSource = source.getByRole('button', { name: 'Close generator' })
  await expectTouchTarget(closeSource)
  await expectTouchTarget(source.getByLabel('LENGTH'))
  await expectTouchTarget(source.locator('.generation-controls').getByRole('button', { name: 'Generate', exact: true }))

  await source.getByLabel(/PROMPT/).fill('clean electric piano pulse at 120 BPM')
  await source.locator('.generation-controls').getByRole('button', { name: 'Generate', exact: true }).click()
  const candidate = source.locator('.candidate-card').filter({ hasText: 'Variation 1' })
  await expect(candidate).toBeVisible()
  await expectTouchTarget(candidate.getByRole('button', { name: 'Preview Variation 1' }))
  await expectTouchTarget(candidate.getByRole('button', { name: 'Place at playhead' }))
  await candidate.getByRole('button', { name: 'Place at playhead' }).click()
  await closeSource.click()
  await expect(arrange).toHaveAttribute('aria-current', 'page')
  await expect(source).toHaveCSS('display', 'none')

  const clip = page.getByRole('button', { name: /Variation 1, audio region/ })
  await clip.click()
  const trimStart = page.getByRole('button', { name: /Trim start of Variation 1/ })
  const trimEnd = page.getByRole('button', { name: /Trim end of Variation 1/ })
  await expectTouchTarget(trimStart)
  await expectTouchTarget(trimEnd)
  const clipLabel = await clip.getAttribute('aria-label')
  await trimEnd.focus()
  await trimEnd.press('ArrowRight')
  await expect.poll(() => clip.getAttribute('aria-label')).not.toBe(clipLabel)

  const mobileLoop = page.locator('.mobile-arrangement-actions').getByRole('button', { name: 'Toggle loop' })
  await expectTouchTarget(mobileLoop)
  await mobileLoop.click()
  await expect(mobileLoop).toHaveAttribute('aria-pressed', 'true')
  const loopStart = page.getByRole('slider', { name: 'Loop start' })
  const loopRange = page.getByRole('slider', { name: 'Loop range position' })
  const loopEnd = page.getByRole('slider', { name: 'Loop end' })
  await expectTouchTarget(loopStart)
  await expectTouchTarget(loopRange)
  await expectTouchTarget(loopEnd)
  const startValue = await loopStart.getAttribute('aria-valuenow')
  await loopStart.focus()
  await loopStart.press('ArrowRight')
  await expect.poll(() => loopStart.getAttribute('aria-valuenow')).not.toBe(startValue)

  await mix.click()
  await expect(mix).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.mobile-mixer')).toHaveCSS('display', 'block')
  await expectTouchTarget(page.getByLabel('Master gain'))
  await expectTouchTarget(page.locator('.mobile-mixer-row button').first())
  await expectTouchTarget(page.locator('.mobile-mixer-row input').first())

  await expectNoNestedInteractiveControls(page)
  await expectVisibleControlsNamed(page)
  await expect(page.locator('[title*="not available in this build"]')).toHaveCount(0)
})
