import { expect, test } from '@playwright/test'

const captureBrowserErrors = (page: import('@playwright/test').Page): string[] => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
  })
  return errors
}

const clickTrackWav = (bpm: number, sampleRate = 8_000, seconds = 12): Buffer => {
  const frameCount = sampleRate * seconds
  const pcm = new Int16Array(frameCount)
  const interval = sampleRate * 60 / bpm
  for (let beat = 0; Math.round(beat * interval) < frameCount; beat += 1) {
    const start = Math.round(beat * interval)
    for (let frame = 0; frame < Math.min(100, frameCount - start); frame += 1) {
      const amplitude = Math.exp(-frame / 18) * (beat % 4 === 0 ? 1 : 0.72)
      pcm[start + frame] = Math.round(amplitude * 0x7fff)
    }
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
  for (let index = 0; index < pcm.length; index += 1) wav.writeInt16LE(pcm[index], 44 + index * 2)
  return wav
}

test('selected audio tempo is analyzed off-main-thread and applied atomically', async ({ page }) => {
  const browserErrors = captureBrowserErrors(page)
  await page.goto('/')
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false')

  await page.locator('input[type="file"][accept^="audio"]').setInputFiles({
    name: 'steady-90-bpm.wav',
    mimeType: 'audio/wav',
    buffer: clickTrackWav(90),
  })
  await expect(page.getByRole('button', { name: /steady-90-bpm.wav, audio region/ })).toBeVisible()

  const inspector = page.getByLabel('Selected region inspector')
  await inspector.getByRole('button', { name: 'Detect tempo from audio' }).click()
  await expect(inspector.getByText('90.0 BPM', { exact: true })).toBeVisible()
  await inspector.getByRole('button', { name: 'Apply 90.0 BPM to project' }).click()
  await expect(page.getByRole('spinbutton', { name: 'Tempo', exact: true })).toHaveValue('90.0')

  await page.locator('.history-controls').getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByRole('spinbutton', { name: 'Tempo', exact: true })).toHaveValue('120.0')
  expect(browserErrors).toEqual([])
})
