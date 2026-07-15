import { expect, test, type Page } from '@playwright/test'

declare global {
  interface Window {
    __vibeseqObservedToasts?: string[]
  }
}

const captureBrowserErrors = (page: Page): string[] => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
  })
  return errors
}

const toneWav = (frequency: number, sampleRate = 16_000, seconds = 24): Buffer => {
  const frameCount = sampleRate * seconds
  const pcm = new Int16Array(frameCount)
  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = frame / sampleRate
    const pulse = 0.62 + Math.sin(2 * Math.PI * 2 * time) * 0.12
    const sample = Math.sin(2 * Math.PI * frequency * time) * pulse * 0.32
    pcm[frame] = Math.round(sample * 0x7fff)
  }

  const wav = Buffer.alloc(44 + pcm.byteLength)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.byteLength - 8, 4)
  wav.write('WAVE', 8)
  wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(pcm.byteLength, 40)
  for (let index = 0; index < pcm.length; index += 1) {
    wav.writeInt16LE(pcm[index], 44 + index * 2)
  }
  return wav
}

async function importAudio(page: Page, name: string, frequency: number) {
  await page.locator('input[type="file"][accept^="audio"]').setInputFiles({
    name: `${name}.wav`,
    mimeType: 'audio/wav',
    buffer: toneWav(frequency),
  })
  await expect(page.getByRole('button', { name: `${name}.wav, audio region` })).toBeVisible()
  await expect(page.getByRole('button', { name: `Select ${name} track`, exact: true })).toBeVisible()
}

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

const currentPlayheadBeat = async (page: Page): Promise<number> => Number(
  await page.getByRole('slider', { name: 'Arrangement playhead' }).getAttribute('aria-valuenow'),
)

test('default AudioWorklet keeps transport continuous through live mix edits and screen re-entry', async ({ page }) => {
  const browserErrors = captureBrowserErrors(page)
  const workletModuleRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('vibeseqAudioProcessor')) workletModuleRequests.push(request.url())
  })

  await page.goto('/')
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false')
  expect(await page.evaluate(() => typeof AudioWorkletNode)).toBe('function')

  await page.evaluate(() => {
    window.__vibeseqObservedToasts = []
    const seen = new Set<string>()
    const capture = () => {
      for (const toast of document.querySelectorAll('.toast')) {
        const message = toast.textContent?.trim()
        if (message && !seen.has(message)) {
          seen.add(message)
          window.__vibeseqObservedToasts?.push(message)
        }
      }
    }
    new MutationObserver(capture).observe(document.body, { childList: true, subtree: true })
    capture()
  })

  // The fixture backend is configured by playwright.config.ts; the two valid
  // encoded WAV files exercise the real browser decoder and default worklet.
  await importAudio(page, 'worklet-bed-a', 220)
  await importAudio(page, 'worklet-bed-b', 330)
  await expect(page.locator('.track-row')).toHaveCount(2)

  const muteA = page.getByRole('button', { name: 'Mute worklet-bed-a', exact: true })
  const muteB = page.getByRole('button', { name: 'Mute worklet-bed-b', exact: true })
  const soloA = page.getByRole('button', { name: 'Solo worklet-bed-a', exact: true })
  const gainA = page.getByRole('slider', { name: 'worklet-bed-a gain', exact: true })
  const gainB = page.getByRole('slider', { name: 'worklet-bed-b gain', exact: true })

  await muteB.click()
  await expect(muteB).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await expect.poll(() => currentPlayheadBeat(page)).toBeGreaterThan(0.1)
  const beatBeforeEdits = await currentPlayheadBeat(page)

  for (const value of ['0.35', '1.05', '0.68']) {
    await gainA.fill(value)
    await gainB.fill((1.25 - Number(value) / 2).toFixed(2))
  }

  await page.getByRole('button', { name: 'Select worklet-bed-a track', exact: true }).click()
  const inspector = page.getByLabel('Selected track inspector')
  const pan = inspector.getByLabel('Pan')
  for (const value of ['-0.75', '0.7', '0']) await pan.fill(value)

  await muteB.click()
  await expect(muteB).toHaveAttribute('aria-pressed', 'false')
  await muteB.click()
  await expect(muteB).toHaveAttribute('aria-pressed', 'true')

  await soloA.click()
  await expect(soloA).toHaveAttribute('aria-pressed', 'true')
  await soloA.click()
  await expect(soloA).toHaveAttribute('aria-pressed', 'false')
  await soloA.click()
  await expect(soloA).toHaveAttribute('aria-pressed', 'true')

  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await expect.poll(() => currentPlayheadBeat(page)).toBeGreaterThan(beatBeforeEdits)
  const beatBeforeReentry = await currentPlayheadBeat(page)

  await dispatchVisibility(page, 'hidden')
  await page.waitForTimeout(250)
  await dispatchVisibility(page, 'visible')

  await expect(page.locator('.track-row')).toHaveCount(2)
  await expect(muteA).toHaveAttribute('aria-pressed', 'false')
  await expect(muteB).toHaveAttribute('aria-pressed', 'true')
  await expect(soloA).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await expect.poll(() => currentPlayheadBeat(page)).toBeGreaterThan(beatBeforeReentry)

  await soloA.click()
  await expect(soloA).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()

  expect(workletModuleRequests.length).toBeGreaterThan(0)
  const observedToasts = await page.evaluate(() => window.__vibeseqObservedToasts ?? [])
  expect(observedToasts.join('\n')).not.toMatch(/Audio engine|asset-missing|asset-load-failed/i)
  expect(browserErrors).toEqual([])
})
