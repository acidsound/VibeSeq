import { expect, test, type Locator, type Page } from '@playwright/test'
import { strFromU8, unzipSync } from 'fflate'
import { readFile } from 'node:fs/promises'

async function expectTouchTarget(locator: Locator) {
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBeGreaterThanOrEqual(44)
  expect(box!.height).toBeGreaterThanOrEqual(44)
}

async function openStudio(page: Page) {
  await page.goto('/')
  await expect(page.getByText('Saved locally · indexeddb')).toBeVisible()
}

async function waitForDurableSave(page: Page) {
  await page.waitForTimeout(700)
  await expect(page.getByText('Saved locally · indexeddb')).toBeVisible()
}

async function generateAndPlace(page: Page) {
  const prompt = 'warm pulse, clean sine motif, 118 BPM'
  await page.getByLabel(/PROMPT/).fill(prompt)
  await page.getByLabel('LENGTH').selectOption('seconds:4')
  await page.locator('.generation-controls').getByRole('button', { name: 'Generate', exact: true }).click()

  const candidate = page.locator('.candidate-card').filter({ hasText: 'Variation 1' })
  await expect(candidate).toBeVisible()
  const waveform = candidate.locator('.candidate-waveform-visual > svg > path')
  await expect(waveform).toHaveCount(1)
  await expect(waveform).not.toHaveAttribute('d', '')

  const [candidateListBox, candidateBox] = await Promise.all([
    page.locator('.candidate-list').boundingBox(),
    candidate.boundingBox(),
  ])
  expect(candidateListBox).not.toBeNull()
  expect(candidateBox).not.toBeNull()
  expect(candidateBox!.y - candidateListBox!.y).toBeGreaterThanOrEqual(1)

  const preview = candidate.getByRole('button', { name: 'Preview Variation 1' })
  const [previewBox, iconBox, waveformBox] = await Promise.all([
    preview.boundingBox(),
    preview.locator('.preview-icon').boundingBox(),
    preview.locator('.candidate-waveform-visual').boundingBox(),
  ])
  expect(previewBox).not.toBeNull()
  expect(iconBox).not.toBeNull()
  expect(waveformBox).not.toBeNull()
  expect(waveformBox!.x).toBeGreaterThanOrEqual(previewBox!.x)
  expect(waveformBox!.x + waveformBox!.width).toBeLessThanOrEqual(previewBox!.x + previewBox!.width + 0.5)
  expect(Math.abs((iconBox!.y + iconBox!.height / 2) - (previewBox!.y + previewBox!.height / 2))).toBeLessThanOrEqual(1)
  await preview.click()
  const stopPreview = candidate.getByRole('button', { name: 'Stop previewing Variation 1' })
  await expect(stopPreview).toBeVisible()
  await stopPreview.click()
  await expect(preview).toBeVisible()

  await candidate.getByRole('button', { name: 'Place at playhead' }).click()
  const audioClip = page.getByRole('button', { name: /Variation 1, audio region/ })
  await expect(audioClip).toBeVisible()
  return { audioClip, prompt }
}

test('blank startup and local project lifecycle never expose synthetic media', async ({ page }) => {
  await openStudio(page)

  await expect(page.locator('.arrangement-heading h1')).toHaveText('Untitled Sequence')
  await expect(page.getByText('Your arrangement is empty')).toBeVisible()
  await expect(page.locator('.timeline-clip')).toHaveCount(0)
  await expect(page.locator('.candidate-card')).toHaveCount(0)
  await expect(page.locator('.clip-waveform, .candidate-waveform svg, .detail-waveform')).toHaveCount(0)
  await expect(page.getByRole('meter', { name: 'Master peak level' })).toHaveAttribute('aria-valuenow', '0')
  await expect(page.locator('[title*="not available in this build"]')).toHaveCount(0)

  await page.locator('.arrangement-empty').getByRole('button', { name: 'Add audio track', exact: true }).click()
  const newTrack = page.getByRole('button', { name: 'Select New audio track' })
  await expect(newTrack).toBeVisible()
  await expect(page.getByRole('meter', { name: 'New audio peak level' })).toHaveAttribute('aria-valuenow', '0')
  await newTrack.click()
  await expect(page.locator('[aria-label="Selected track inspector"]')).toContainText('New audio')
  const inspectorMute = page.locator('[aria-label="Selected track inspector"]').getByRole('button', { name: 'M · Mute' })
  await inspectorMute.click()
  await expect(inspectorMute).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('banner', { name: 'Project transport' }).getByRole('button', { name: 'Open project menu' }).click()
  await expect(page.getByRole('dialog', { name: 'Project' })).toBeVisible()
  await page.getByLabel('Project name').fill('Studio Project Alpha')
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(page.locator('.arrangement-heading h1')).toHaveText('Studio Project Alpha')
  await waitForDurableSave(page)

  await page.reload()
  await expect(page.locator('.arrangement-heading h1')).toHaveText('Studio Project Alpha')

  await page.getByRole('banner', { name: 'Project transport' }).getByRole('button', { name: 'Open project menu' }).click()
  await page.getByRole('button', { name: /New project/ }).click()
  await expect(page.locator('.arrangement-heading h1')).toHaveText('Untitled Sequence')
  await expect(page.getByText('Your arrangement is empty')).toBeVisible()
  await expect(page.getByText('Saved locally · indexeddb')).toBeVisible()

  await page.getByLabel(/PROMPT/).fill('new project boundary regression, short pulse')
  await page.getByLabel('LENGTH').selectOption('seconds:4')
  await page.locator('.generation-controls').getByRole('button', { name: 'Generate', exact: true }).click()
  await expect(page.locator('.candidate-card').filter({ hasText: 'Variation 1' })).toBeVisible()
  await expect(page.locator('.arrangement-heading h1')).toHaveText('Untitled Sequence')
  await expect(page.getByRole('button', { name: 'Select New audio track' })).toHaveCount(0)
  await waitForDurableSave(page)

  await page.reload()
  await expect(page.locator('.arrangement-heading h1')).toHaveText('Untitled Sequence')
  await expect(page.locator('.candidate-card').filter({ hasText: 'Variation 1' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Select New audio track' })).toHaveCount(0)

  await page.getByRole('banner', { name: 'Project transport' }).getByRole('button', { name: 'Open project menu' }).click()
  const priorProject = page.locator('.local-project-list button').filter({ hasText: 'Studio Project Alpha' })
  await expect(priorProject).toBeVisible()
  await priorProject.click()
  await expect(page.locator('.arrangement-heading h1')).toHaveText('Studio Project Alpha')

  await page.getByLabel(/PROMPT/).fill('project reopen playback synchronization regression')
  await page.getByLabel('LENGTH').selectOption('seconds:4')
  await page.locator('.generation-controls').getByRole('button', { name: 'Generate', exact: true }).click()
  const reopenedCandidate = page.locator('.candidate-card').filter({ hasText: 'Variation 1' }).first()
  await reopenedCandidate.getByRole('button', { name: 'Place at playhead' }).click()
  await expect(page.getByRole('button', { name: /Variation 1, audio region/ })).toBeVisible()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Stop', exact: true }).click()

  await page.getByRole('banner', { name: 'Project transport' }).getByRole('button', { name: 'Open project menu' }).click()
  await page.getByRole('button', { name: 'Delete project Untitled Sequence' }).click()
  const deleteInactive = page.getByRole('alertdialog', { name: 'Delete “Untitled Sequence”?' })
  await expect(deleteInactive).toContainText('Global Sound Library sounds are kept')
  await deleteInactive.getByRole('button', { name: 'Delete project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Delete project Untitled Sequence' })).toHaveCount(0)
  await expect(page.locator('.arrangement-heading h1')).toHaveText('Studio Project Alpha')

  await page.getByRole('button', { name: 'Delete project Studio Project Alpha' }).click()
  const deleteCurrent = page.getByRole('alertdialog', { name: 'Delete “Studio Project Alpha”?' })
  await expect(deleteCurrent).toContainText('A different project will open after deletion')
  await deleteCurrent.getByRole('button', { name: 'Delete project', exact: true }).click()
  await expect(page.locator('.arrangement-heading h1')).toHaveText('Untitled Sequence')
  await expect(page.getByText('Your arrangement is empty')).toBeVisible()
  await waitForDurableSave(page)

  await page.reload()
  await expect(page.locator('.arrangement-heading h1')).toHaveText('Untitled Sequence')
  await page.getByLabel('Sound source').getByRole('button', { name: 'Library', exact: true }).click()
  await expect(page.getByLabel('Sound source').locator('.library-card').filter({ hasText: 'Variation 1' })).toBeVisible()
  await page.getByRole('banner', { name: 'Project transport' }).getByRole('button', { name: 'Open project menu' }).click()
  await expect(page.getByRole('button', { name: 'Delete project Studio Project Alpha' })).toHaveCount(0)
})

test('fixture core loop edits MIDI, persists, exports, and keeps mobile controls functional', async ({ page }) => {
  await openStudio(page)
  const { audioClip, prompt: generatedPrompt } = await generateAndPlace(page)

  const source = page.getByLabel('Sound source')
  const promptInput = page.getByLabel(/PROMPT/)
  await promptInput.fill('temporary prompt that must be replaced')
  await source.getByRole('button', { name: 'Library', exact: true }).click()
  await expect(source.getByRole('heading', { name: 'Sound Library', exact: true })).toBeVisible()

  const audioInspector = page.getByLabel('Selected region inspector')
  await audioInspector.getByRole('button', { name: 'Reuse prompt in Generate sound', exact: true }).click()
  await expect(source.getByRole('heading', { name: 'Generate sound', exact: true })).toBeVisible()
  await expect(promptInput).toHaveValue(generatedPrompt)
  await expect(promptInput).toBeFocused()

  const audioLabelBeforeTrim = await audioClip.getAttribute('aria-label')
  const trimEnd = page.getByRole('group', { name: 'Variation 1 region controls' }).getByRole('button', { name: 'Trim end of Variation 1' })
  const trimBox = await trimEnd.boundingBox()
  expect(trimBox).not.toBeNull()
  await page.mouse.move(trimBox!.x + trimBox!.width / 2, trimBox!.y + trimBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(trimBox!.x + trimBox!.width / 2 + 32, trimBox!.y + trimBox!.height / 2)
  await page.mouse.up()
  await expect.poll(() => audioClip.getAttribute('aria-label')).not.toBe(audioLabelBeforeTrim)

  await page.getByRole('button', { name: 'Extract MIDI', exact: true }).click()
  const midiClip = page.getByRole('button', { name: /Variation 1 · MIDI, midi region/ })
  await expect(midiClip).toBeVisible()

  const midiInspector = page.getByLabel('Selected region inspector')
  await midiInspector.getByRole('button', { name: 'Reveal linked audio region Variation 1 in Arrangement', exact: true }).click()
  await expect(audioClip).toHaveAttribute('aria-label', /^Selected, Variation 1, audio region/)
  await expect(audioClip).toBeFocused()
  await expect(midiInspector).toContainText('AUDIO REGION')

  await midiClip.click()
  await expect(midiClip).toHaveAttribute('aria-label', /^Selected, Variation 1 · MIDI, midi region/)

  const notes = page.locator('.piano-note')
  await expect(notes.first()).toBeVisible()
  const durationBefore = await notes.first().getAttribute('aria-label')
  await notes.first().focus()
  await notes.first().press('Shift+ArrowRight')
  await expect.poll(() => notes.first().getAttribute('aria-label')).not.toBe(durationBefore)

  const velocity = page.locator('.velocity-lane button').first()
  const velocityBefore = await velocity.getAttribute('aria-valuenow')
  await velocity.focus()
  await velocity.press('ArrowDown')
  await expect.poll(() => velocity.getAttribute('aria-valuenow')).not.toBe(velocityBefore)

  const noteCount = await notes.count()
  expect(noteCount).toBeGreaterThan(1)
  await notes.last().focus()
  await notes.last().press('Delete')
  await expect(notes).toHaveCount(noteCount - 1)

  const desktopUndo = page.locator('.history-controls').getByRole('button', { name: 'Undo' })
  const desktopRedo = page.locator('.history-controls').getByRole('button', { name: 'Redo' })
  await desktopUndo.click()
  await expect(notes).toHaveCount(noteCount)
  await desktopRedo.click()
  await expect(notes).toHaveCount(noteCount - 1)

  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()

  await waitForDurableSave(page)
  await page.reload()
  await expect(page.getByRole('button', { name: /Variation 1, audio region/ })).toBeVisible()
  const persistedMidiClip = page.getByRole('button', { name: /Variation 1 · MIDI, midi region/ })
  await expect(persistedMidiClip).toBeVisible()
  await persistedMidiClip.click()
  await expect(page.locator('.piano-note')).toHaveCount(noteCount - 1)

  const persistedAudioLabel = await page.getByRole('button', { name: /Variation 1, audio region/ }).getAttribute('aria-label')
  const startBeat = Number(persistedAudioLabel?.match(/starts at beat ([\d.]+)/)?.[1])
  const durationBeats = Number(persistedAudioLabel?.match(/duration ([\d.]+) beats/)?.[1])
  expect(startBeat).toBeGreaterThanOrEqual(0)
  expect(durationBeats).toBeGreaterThan(0)

  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await page.getByLabel('Project sample rate').selectOption('48000')
  await page.getByLabel('WAV bit depth').selectOption('16')
  await expect(page.getByText('16-bit PCM · deterministic TPDF dither', { exact: true })).toBeVisible()
  const wavDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: /Full mix · WAV/ }).click()
  const wavDownload = await wavDownloadPromise
  const wavPath = await wavDownload.path()
  expect(wavPath).not.toBeNull()
  const wav = await readFile(wavPath!)
  expect(wav.subarray(0, 4).toString()).toBe('RIFF')
  expect(wav.subarray(8, 12).toString()).toBe('WAVE')
  expect(wav.readUInt16LE(20)).toBe(1)
  expect(wav.readUInt16LE(22)).toBe(2)
  expect(wav.readUInt32LE(24)).toBe(48_000)
  expect(wav.readUInt32LE(28)).toBe(48_000 * 2 * 2)
  expect(wav.readUInt16LE(32)).toBe(4)
  expect(wav.readUInt16LE(34)).toBe(16)
  expect(wav.subarray(36, 40).toString()).toBe('data')
  const dataSize = wav.readUInt32LE(40)
  expect(wav.length).toBe(44 + dataSize)
  expect(dataSize / 4).toBe(Math.round(((startBeat + durationBeats) * 60 / 120) * 48_000))
  expect(wav.subarray(44).some((byte) => byte !== 0)).toBe(true)

  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await page.getByLabel('WAV bit depth').selectOption('16')
  const trackDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export track 1 Generated audio as WAV' }).click()
  const trackDownload = await trackDownloadPromise
  expect(trackDownload.suggestedFilename()).toContain('-track-01-Generated-audio-48k-16bit.wav')
  const trackPath = await trackDownload.path()
  expect(trackPath).not.toBeNull()
  const trackWav = await readFile(trackPath!)
  expect(trackWav.subarray(0, 4).toString()).toBe('RIFF')
  expect(trackWav.readUInt16LE(22)).toBe(2)
  expect(trackWav.readUInt32LE(24)).toBe(48_000)
  expect(trackWav.readUInt32LE(40)).toBe(dataSize)
  expect(trackWav.subarray(44).some((byte) => byte !== 0)).toBe(true)
  expect(trackWav).not.toEqual(wav)

  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await page.getByLabel('WAV bit depth').selectOption('16')
  const stemsDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: /All individual tracks · ZIP/ }).click()
  const stemsDownload = await stemsDownloadPromise
  expect(stemsDownload.suggestedFilename()).toContain('-individual-tracks-48k-16bit.zip')
  const stemsPath = await stemsDownload.path()
  expect(stemsPath).not.toBeNull()
  const stemsArchive = unzipSync(await readFile(stemsPath!))
  const stemNames = Object.keys(stemsArchive).filter((name) => name.endsWith('.wav'))
  expect(stemNames).toHaveLength(2)
  for (const stemName of stemNames) {
    const stem = Buffer.from(stemsArchive[stemName])
    expect(stem.subarray(0, 4).toString()).toBe('RIFF')
    expect(stem.readUInt32LE(24)).toBe(48_000)
    expect(stem.readUInt32LE(40)).toBe(dataSize)
  }
  const stemsManifest = JSON.parse(strFromU8(stemsArchive['manifest.json']))
  expect(stemsManifest).toMatchObject({
    schema: 'vibeseq-track-stems',
    version: 1,
    format: { sampleRate: 48_000, bitDepth: 16, channels: 2 },
  })
  expect(stemsManifest.tracks).toHaveLength(2)

  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(page.getByLabel('Project sample rate')).toHaveValue('48000')
  await page.getByLabel('WAV bit depth').selectOption('16')
  const repeatedWavDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: /Full mix · WAV/ }).click()
  const repeatedWavDownload = await repeatedWavDownloadPromise
  const repeatedWavPath = await repeatedWavDownload.path()
  expect(repeatedWavPath).not.toBeNull()
  expect(await readFile(repeatedWavPath!)).toEqual(wav)
  await waitForDurableSave(page)

  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const midiDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: /MIDI structure/ }).click()
  const midiDownload = await midiDownloadPromise
  const midiPath = await midiDownload.path()
  expect(midiPath).not.toBeNull()
  const midi = await readFile(midiPath!)
  expect(midi.subarray(0, 4).toString()).toBe('MThd')
  expect(midi.readUInt16BE(8)).toBe(1)
  expect(midi.readUInt16BE(12)).toBe(480)

  await page.setViewportSize({ width: 360, height: 800 })
  await page.reload()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
  expect(await page.locator('.arrangement-scroll').evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)

  const mobileStop = page.getByRole('button', { name: 'Stop', exact: true })
  const mobileUndo = page.locator('.mobile-arrangement-actions').getByRole('button', { name: 'Undo' })
  const mobileRedo = page.locator('.mobile-arrangement-actions').getByRole('button', { name: 'Redo' })
  const mobileLoop = page.locator('.mobile-arrangement-actions').getByRole('button', { name: 'Toggle loop' })
  await expectTouchTarget(mobileStop)
  await expectTouchTarget(mobileUndo)
  await expectTouchTarget(mobileRedo)

  await mobileLoop.click()
  await expect(page.locator('.loop-brace')).toBeVisible()
  await mobileUndo.click()
  await expect(page.locator('.loop-brace')).toHaveCount(0)
  await mobileRedo.click()
  await expect(page.locator('.loop-brace')).toBeVisible()

  await audioClip.click()
  await page.locator('.mobile-context-bar').getByRole('button', { name: 'More', exact: true }).click()
  await expect(audioInspector).toHaveCSS('display', 'block')
  await audioInspector.getByRole('button', { name: 'Reuse prompt in Generate sound', exact: true }).click()
  await expect(source).toHaveCSS('display', 'grid')
  await expect(audioInspector).toHaveCSS('display', 'none')
  await expect(promptInput).toHaveValue(generatedPrompt)
  await expect(promptInput).toBeFocused()
  await page.getByRole('navigation', { name: 'Studio surfaces' }).getByRole('button', { name: 'Arrange', exact: true }).click()

  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await mobileStop.click()
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()

  await page.getByRole('banner', { name: 'Project transport' }).getByRole('button', { name: 'Open project menu' }).click()
  const mobileExport = page.getByRole('dialog', { name: 'Project' }).getByRole('button', { name: /Export render/ })
  await expectTouchTarget(mobileExport)
  await mobileExport.click()
  await expect(page.getByRole('dialog', { name: 'Export arrangement' })).toBeVisible()
  await expect(page.getByLabel('Project sample rate')).toHaveValue('48000')
  await page.getByRole('button', { name: 'Close export dialog' }).click()

  await page.getByRole('button', { name: /Variation 1 · MIDI, midi region/ }).click()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const detail = page.locator('.detail-panel')
  await expect(detail).toHaveCSS('display', 'flex')
  await expectTouchTarget(page.getByRole('button', { name: 'Expand detail sheet' }))
  const collapsedBox = await detail.boundingBox()
  expect(collapsedBox).not.toBeNull()
  expect(collapsedBox!.y).toBeGreaterThan(72)
  await page.getByRole('button', { name: 'Expand detail sheet' }).click()
  await expect(page.getByRole('button', { name: 'Collapse detail sheet' })).toBeVisible()
  const expandedBox = await detail.boundingBox()
  expect(expandedBox).not.toBeNull()
  expect(expandedBox!.y).toBeLessThanOrEqual(73)

  await page.getByRole('navigation', { name: 'Studio surfaces' }).getByRole('button', { name: 'Arrange', exact: true }).click()
  await expect(detail).toHaveCSS('display', 'none')

  await page.getByRole('navigation', { name: 'Studio surfaces' }).getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.locator('.source-panel')).toHaveCSS('display', 'grid')
  await expectTouchTarget(page.getByLabel('LENGTH'))
  await expectTouchTarget(page.locator('.generation-controls').getByRole('button', { name: 'Generate', exact: true }))

  await page.getByRole('navigation', { name: 'Studio surfaces' }).getByRole('button', { name: 'Mix', exact: true }).click()
  await expect(page.locator('.mobile-mixer')).toHaveCSS('display', 'block')
  await expect(page.locator('.source-panel')).toHaveCSS('display', 'none')
  await expectTouchTarget(page.locator('.mobile-mixer-row button').first())
  await expectTouchTarget(page.locator('.mobile-mixer-row input').first())
})
