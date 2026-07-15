import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const realMediumEnabled = process.env.VIBESEQ_REAL_MEDIUM_E2E === '1'
const REAL_PROMPT = 'warm neo-soul drums, loose pocket, electric piano texture, instrumental'
// Pinned inputs make the real-model workflow reproducible instead of coupling
// extraction quality to a wall-clock-generated seed.
const REAL_GENERATION_SEEDS = [61_061, 68_309] as const
const REAL_MEDIUM_CONTRACTS = {
  'local-apple': {
    evidenceDirectory: 'artifacts/qa/2026-07-15-real-medium',
    timeout: 300_000,
    jobTimeout: 120_000,
    generation: {
      modelId: 'stabilityai/stable-audio-3-optimized',
      modelRevision: 'c2949a435de2392fe49c5914c52bc174cfc05a9b',
      runtime: 'mlx',
      route: 'apple-mlx',
      device: 'metal',
    },
    transcription: {
      runtime: 'pytorch-mps',
      route: 'apple-mps',
      device: 'mps',
    },
  },
  'local-cpu': {
    evidenceDirectory: 'artifacts/qa/2026-07-15-real-medium-cpu-browser',
    timeout: 900_000,
    jobTimeout: 300_000,
    generation: {
      modelId: 'stabilityai/stable-audio-3-optimized',
      modelRevision: 'c2949a435de2392fe49c5914c52bc174cfc05a9b',
      runtime: 'tflite-w8a8-dyn',
      route: 'cpu-tflite',
      device: 'cpu',
    },
    transcription: {
      runtime: 'pytorch-cpu',
      route: 'cpu-pytorch',
      device: 'cpu',
    },
  },
  'colab-t4': {
    evidenceDirectory: 'artifacts/qa/2026-07-15-colab-t4-medium',
    timeout: 600_000,
    jobTimeout: 240_000,
    generation: {
      modelId: 'stabilityai/stable-audio-3-medium',
      modelRevision: '27b5a21b791b1b033d193a9e1e3ce78493f102f9',
      runtime: 'pytorch-sdpa',
      route: 'cuda-t4-sdpa',
      device: 'cuda',
    },
    transcription: {
      runtime: 'pytorch-cuda',
      route: 'cuda-pytorch',
      device: 'cuda',
    },
  },
} as const
type RealMediumTarget = keyof typeof REAL_MEDIUM_CONTRACTS
const configuredTarget = process.env.VIBESEQ_REAL_MEDIUM_TARGET ?? 'local-apple'
if (!(configuredTarget in REAL_MEDIUM_CONTRACTS)) {
  throw new Error(`VIBESEQ_REAL_MEDIUM_TARGET must be local-apple, local-cpu, or colab-t4, received ${configuredTarget}`)
}
const REAL_MEDIUM_TARGET = configuredTarget as RealMediumTarget
const REAL_MEDIUM_CONTRACT = REAL_MEDIUM_CONTRACTS[REAL_MEDIUM_TARGET]
const EVIDENCE_DIR = path.resolve(REAL_MEDIUM_CONTRACT.evidenceDirectory)
type JobKind = 'generate' | 'transcribe'

type JobEnvelope<T> = {
  id: string
  type?: JobKind
  kind?: JobKind
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress: number
  result?: T
  error?: string | null
}

type GenerationResult = {
  assetId: string
  assetUrl: string
  duration: number
  sampleRate?: number
  provider: string
  device: string
  model: string
  modelId: string
  modelRevision: string
  codeRevision: string
  runtime: string
  route: string
}

type TranscriptionResult = {
  midiAssetId: string
  midiAssetUrl: string
  notes: Array<{ pitch: number; startTime: number; endTime: number; velocity: number }>
  provider: string
  device: string
  model: string
  modelId: string
  modelRevision: string
  codeRevision: string
  runtime: string
  route: string
}

type GenerateInput = {
  prompt: string
  duration: number
  bpm: number
  seed: number
  provider: string
}

type WavInspection = {
  audioFormat: number
  channels: number
  sampleRate: number
  byteRate: number
  blockAlign: number
  bitDepth: number
  dataLength: number
  dataOffset: number
}

type SmfInspection = {
  format: number
  declaredTracks: number
  parsedTracks: number
  ppq: number
  noteOnPitches: number[]
  noteOnVelocities: number[]
}

type ProjectBundleInspection = {
  format: string
  serializationVersion: number
  schemaVersion: number
  checkpointId: string
  revision: number
  projectName: string
  tracks: number
  clips: number
  jobs: number
  candidates: number
  jobSeeds: number[]
  candidateSeeds: number[]
  mediaRecords: number
  hashesVerified: number
  bytes: number
}

function inspectProjectBundle(bytes: Buffer): ProjectBundleInspection {
  const bundle = JSON.parse(bytes.toString('utf8')) as {
    format: string
    serializationVersion: number
    checkpointId: string
    revision: number
    project: {
      schemaVersion: number
      name: string
      tracks: Array<{ clips: unknown[] }>
      jobs: Array<{ input?: { seed?: number } }>
      assets: Array<{
        blob?: { __vibeseqBinary?: boolean; base64?: string }
        bytes?: { __vibeseqBinary?: boolean; base64?: string }
        contentHashSha256?: string
      }>
    }
    session: {
      candidates: Array<{
        seed?: number
        blob?: { __vibeseqBinary?: boolean; base64?: string }
        bytes?: { __vibeseqBinary?: boolean; base64?: string }
        contentHashSha256?: string
      }>
    }
  }
  const media = [...bundle.project.assets, ...bundle.session.candidates]
  let hashesVerified = 0
  for (const item of media) {
    const envelope = item.blob ?? item.bytes
    expect(envelope?.__vibeseqBinary, 'bundle media must use the portable binary envelope').toBe(true)
    expect(envelope?.base64, 'bundle media must contain encoded bytes').toBeTruthy()
    expect(item.contentHashSha256, 'bundle media must carry a SHA-256 identity').toMatch(/^[a-f0-9]{64}$/)
    const actualHash = createHash('sha256').update(Buffer.from(envelope!.base64!, 'base64')).digest('hex')
    expect(actualHash, 'bundle media bytes must match their persisted identity').toBe(item.contentHashSha256)
    hashesVerified += 1
  }
  return {
    format: bundle.format,
    serializationVersion: bundle.serializationVersion,
    schemaVersion: bundle.project.schemaVersion,
    checkpointId: bundle.checkpointId,
    revision: bundle.revision,
    projectName: bundle.project.name,
    tracks: bundle.project.tracks.length,
    clips: bundle.project.tracks.reduce((count, track) => count + track.clips.length, 0),
    jobs: bundle.project.jobs.length,
    candidates: bundle.session.candidates.length,
    jobSeeds: bundle.project.jobs.flatMap((job) => Number.isInteger(job.input?.seed) ? [job.input!.seed!] : []),
    candidateSeeds: bundle.session.candidates.flatMap((candidate) => Number.isInteger(candidate.seed) ? [candidate.seed!] : []),
    mediaRecords: media.length,
    hashesVerified,
    bytes: bytes.length,
  }
}

const jobPath = (id: string) => `/api/jobs/${encodeURIComponent(id)}`

async function triggerAndWaitForJob<T>(
  page: Page,
  acceptedPath: '/api/generate' | '/api/transcribe',
  kind: JobKind,
  trigger: () => Promise<unknown>,
  timeout: number,
): Promise<{ input?: GenerateInput; job: JobEnvelope<T> }> {
  const acceptedPromise = page.waitForResponse((response) => {
    const request = response.request()
    return new URL(response.url()).pathname === acceptedPath
      && request.method() === 'POST'
      && response.status() === 202
  }, { timeout: 15_000 })

  await trigger()
  const acceptedResponse = await acceptedPromise
  const accepted = await acceptedResponse.json() as JobEnvelope<T>
  expect(accepted.id, `${kind} request must return a durable job id`).toBeTruthy()

  let terminal: JobEnvelope<T> | undefined
  await page.waitForResponse(async (response) => {
    const request = response.request()
    if (new URL(response.url()).pathname !== jobPath(accepted.id) || request.method() !== 'GET' || !response.ok()) return false
    const candidate = await response.json() as JobEnvelope<T>
    if (!['completed', 'failed', 'cancelled'].includes(candidate.status)) return false
    terminal = candidate
    return true
  }, { timeout })

  expect(terminal?.status, `${kind} job ${accepted.id} failed: ${terminal?.error ?? 'no terminal result'}`).toBe('completed')
  expect(terminal?.type ?? terminal?.kind).toBe(kind)
  expect(terminal?.progress).toBe(1)
  expect(terminal?.result, `${kind} job must return a result`).toBeTruthy()

  let input: GenerateInput | undefined
  if (acceptedPath === '/api/generate') input = acceptedResponse.request().postDataJSON() as GenerateInput
  return { input, job: terminal! }
}

function assertNoFallbackIdentity(identity: Record<string, unknown>) {
  const routeIdentity = [
    identity.provider,
    identity.model,
    identity.modelId,
    identity.runtime,
    identity.route,
    identity.device,
  ].filter(Boolean).join(' ').toLowerCase()
  expect(routeIdentity).not.toMatch(/\bsmall\b/)
  expect(routeIdentity).not.toMatch(/demo|fixture/)
}

function assertStableAudioMedium(result: GenerationResult) {
  const expected = REAL_MEDIUM_CONTRACT.generation
  expect(result.provider).toBe('stable-audio-3')
  expect(result.model).toBe('medium')
  expect(result.modelId).toBe(expected.modelId)
  expect(result.modelRevision).toBe(expected.modelRevision)
  expect(result.codeRevision).toBe('b32763cf3b71c160f10a0daa4fa0e0d471b5772e')
  expect(result.runtime).toBe(expected.runtime)
  expect(result.route).toBe(expected.route)
  expect(result.device).toBe(expected.device)
  if (result.sampleRate !== undefined) expect(result.sampleRate).toBe(44_100)
  assertNoFallbackIdentity(result as unknown as Record<string, unknown>)
}

function assertMuScriptorMedium(result: TranscriptionResult) {
  const expected = REAL_MEDIUM_CONTRACT.transcription
  expect(result.provider).toBe('muscriptor')
  expect(result.model).toBe('medium')
  expect(result.modelId).toBe('MuScriptor/muscriptor-medium')
  expect(result.modelRevision).toBe('f32236969308476e01fd3aae67357de5feb05a2d')
  expect(result.codeRevision).toBe('6c1460cc75e5f120948de7656da05b2c489e8715')
  expect(result.runtime).toBe(expected.runtime)
  expect(result.route).toBe(expected.route)
  expect(result.device).toBe(expected.device)
  assertNoFallbackIdentity(result as unknown as Record<string, unknown>)
}

async function auditionCandidate(page: Page, name: string) {
  const candidate = page.locator('.candidate-card').filter({ has: page.getByText(name, { exact: true }) })
  await expect(candidate).toHaveCount(1)
  await expect(candidate).toContainText('stable-audio-3')
  await expect(candidate).toContainText(`medium · ${REAL_MEDIUM_CONTRACT.generation.runtime}`)
  expect((await candidate.textContent())?.toLowerCase()).not.toMatch(/\bsmall\b|demo|fixture/)

  const preview = candidate.getByRole('button', { name: `Preview ${name}`, exact: true })
  await preview.click()
  const stop = candidate.getByRole('button', { name: `Stop previewing ${name}`, exact: true })
  await expect(stop).toBeVisible()
  await expect(stop).toHaveAttribute('aria-pressed', 'true')
  await stop.click()
  await expect(preview).toBeVisible()
  await expect(preview).toHaveAttribute('aria-pressed', 'false')
  return candidate
}

async function waitForDurableSave(page: Page) {
  const status = page.locator('.status-bar > span').first()
  await page.waitForTimeout(900)
  await expect(status).toContainText('Saved locally · indexeddb')
  await expect(status).not.toContainText(/Saving|Save failed|unavailable/i)
}

function parseClipTiming(label: string | null): { startBeat: number; durationBeats: number } {
  const match = label?.match(/starts at beat ([\d.]+), duration ([\d.]+) beats/)
  expect(match, `clip label must expose start and duration: ${label ?? '<missing>'}`).not.toBeNull()
  return { startBeat: Number(match![1]), durationBeats: Number(match![2]) }
}

async function seekToBeat(page: Page, beat: number) {
  const ruler = page.getByRole('slider', { name: 'Arrangement playhead' })
  const box = await ruler.boundingBox()
  expect(box).not.toBeNull()
  const timeline = page.locator('.timeline-ruler')
  const timelineBeats = Number(await timeline.getAttribute('data-timeline-beats'))
  expect(timelineBeats).toBeGreaterThan(0)
  const x = Math.max(1, Math.min(box!.width - 1, (beat / timelineBeats) * box!.width))
  await ruler.click({ position: { x, y: box!.height / 2 } })
  await expect.poll(async () => Number(await ruler.getAttribute('aria-valuenow'))).toBeCloseTo(beat, 2)
}

function inspectWav(bytes: Buffer): WavInspection {
  expect(bytes.subarray(0, 4).toString()).toBe('RIFF')
  expect(bytes.subarray(8, 12).toString()).toBe('WAVE')
  let offset = 12
  let format: Omit<WavInspection, 'dataLength' | 'dataOffset'> | undefined
  let dataLength: number | undefined
  let dataOffset: number | undefined
  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString()
    const length = bytes.readUInt32LE(offset + 4)
    const payload = offset + 8
    expect(payload + length, `${id} chunk must fit inside the WAV`).toBeLessThanOrEqual(bytes.length)
    if (id === 'fmt ') {
      expect(length).toBeGreaterThanOrEqual(16)
      format = {
        audioFormat: bytes.readUInt16LE(payload),
        channels: bytes.readUInt16LE(payload + 2),
        sampleRate: bytes.readUInt32LE(payload + 4),
        byteRate: bytes.readUInt32LE(payload + 8),
        blockAlign: bytes.readUInt16LE(payload + 12),
        bitDepth: bytes.readUInt16LE(payload + 14),
      }
    }
    if (id === 'data') {
      dataLength = length
      dataOffset = payload
      break
    }
    offset = payload + length + (length % 2)
  }
  expect(format, 'WAV must contain a fmt chunk').toBeTruthy()
  expect(dataLength, 'WAV must contain a non-empty data chunk').toBeGreaterThan(0)
  expect(dataOffset).toBeDefined()
  return { ...format!, dataLength: dataLength!, dataOffset: dataOffset! }
}

function readVariableLength(bytes: Buffer, start: number, end: number): { value: number; next: number } {
  let value = 0
  let offset = start
  for (let count = 0; count < 4 && offset < end; count += 1) {
    const byte = bytes[offset++]
    value = (value << 7) | (byte & 0x7f)
    if ((byte & 0x80) === 0) return { value, next: offset }
  }
  throw new Error('Invalid or truncated MIDI variable-length value')
}

function inspectSmf(bytes: Buffer): SmfInspection {
  expect(bytes.subarray(0, 4).toString()).toBe('MThd')
  expect(bytes.readUInt32BE(4)).toBe(6)
  const format = bytes.readUInt16BE(8)
  const declaredTracks = bytes.readUInt16BE(10)
  const ppq = bytes.readUInt16BE(12)
  const noteOnPitches: number[] = []
  const noteOnVelocities: number[] = []
  let parsedTracks = 0
  let offset = 14

  while (offset + 8 <= bytes.length) {
    expect(bytes.subarray(offset, offset + 4).toString()).toBe('MTrk')
    const length = bytes.readUInt32BE(offset + 4)
    offset += 8
    const end = offset + length
    expect(end, 'MTrk chunk must fit inside the SMF').toBeLessThanOrEqual(bytes.length)
    let runningStatus = 0
    while (offset < end) {
      offset = readVariableLength(bytes, offset, end).next
      let status = bytes[offset]
      if (status >= 0x80) {
        offset += 1
        if (status < 0xf0) runningStatus = status
      } else {
        if (!runningStatus) throw new Error('MIDI running status appeared before a channel status')
        status = runningStatus
      }
      if (status === 0xff) {
        offset += 1
        const lengthField = readVariableLength(bytes, offset, end)
        offset = lengthField.next + lengthField.value
        continue
      }
      if (status === 0xf0 || status === 0xf7) {
        const lengthField = readVariableLength(bytes, offset, end)
        offset = lengthField.next + lengthField.value
        continue
      }
      const eventType = status & 0xf0
      const dataLength = eventType === 0xc0 || eventType === 0xd0 ? 1 : 2
      const first = bytes[offset]
      const second = dataLength === 2 ? bytes[offset + 1] : 0
      offset += dataLength
      if (eventType === 0x90 && second > 0) {
        noteOnPitches.push(first)
        noteOnVelocities.push(second)
      }
    }
    expect(offset).toBe(end)
    parsedTracks += 1
  }

  expect(offset).toBe(bytes.length)
  return { format, declaredTracks, parsedTracks, ppq, noteOnPitches, noteOnVelocities }
}

test.skip(!realMediumEnabled, 'Opt-in test requires a running real-Medium Studio target')

test('two real Stable Audio Medium candidates complete the MuScriptor production loop', async ({ page }, testInfo) => {
  test.setTimeout(REAL_MEDIUM_CONTRACT.timeout)
  const runLabel = `run-${String(testInfo.repeatEachIndex + 1).padStart(2, '0')}-attempt-${String(testInfo.retry + 1).padStart(2, '0')}`
  const evidencePrefix = `browser-real-medium-${runLabel}`
  await mkdir(EVIDENCE_DIR, { recursive: true })

  await page.goto('/')
  await expect(page.getByText('Saved locally · indexeddb')).toBeVisible()
  await expect(page.locator('.timeline-clip')).toHaveCount(0)
  await expect(page.locator('.candidate-card')).toHaveCount(0)
  await expect(page.getByRole('button', {
    name: new RegExp(`Stable Audio 3 Medium · ${REAL_MEDIUM_CONTRACT.generation.runtime} · ready`),
  })).toBeVisible()

  const healthResponse = await page.request.get('/api/health')
  expect(healthResponse.ok()).toBe(true)
  const health = await healthResponse.json() as {
    generation: Record<string, unknown>
    transcription: Record<string, unknown>
  }
  expect(health.generation.ready).toBe(true)
  expect(health.transcription.ready).toBe(true)
  assertStableAudioMedium(health.generation as unknown as GenerationResult)
  assertMuScriptorMedium(health.transcription as unknown as TranscriptionResult)

  await page.getByLabel(/PROMPT/).fill(REAL_PROMPT)
  await page.getByLabel('LENGTH').selectOption('seconds:4')
  const generationSeed = page.getByRole('spinbutton', { name: 'Generation seed', exact: true })
  await generationSeed.fill(String(REAL_GENERATION_SEEDS[0]))
  await generationSeed.press('Enter')
  await expect(generationSeed).toHaveValue(String(REAL_GENERATION_SEEDS[0]))
  const projectBpm = Number(await page.getByLabel('Tempo').inputValue())
  expect(projectBpm).toBe(120)
  const firstGeneration = await triggerAndWaitForJob<GenerationResult>(
    page,
    '/api/generate',
    'generate',
    () => page.locator('.generation-controls').getByRole('button', { name: 'Generate', exact: true }).click(),
    REAL_MEDIUM_CONTRACT.jobTimeout,
  )
  const firstResult = firstGeneration.job.result!
  assertStableAudioMedium(firstResult)
  await expect(page.getByText('Variation 1', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.candidate-card').filter({ hasText: 'Variation 1' })).toContainText(`Seed ${REAL_GENERATION_SEEDS[0]}`)

  await generationSeed.fill(String(REAL_GENERATION_SEEDS[1]))
  await generationSeed.press('Enter')
  await expect(generationSeed).toHaveValue(String(REAL_GENERATION_SEEDS[1]))

  const secondGeneration = await triggerAndWaitForJob<GenerationResult>(
    page,
    '/api/generate',
    'generate',
    () => page.locator('.generation-controls').getByRole('button', { name: 'Generate', exact: true }).click(),
    REAL_MEDIUM_CONTRACT.jobTimeout,
  )
  const secondResult = secondGeneration.job.result!
  assertStableAudioMedium(secondResult)
  await expect(page.getByText('Variation 2', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.candidate-card').filter({ hasText: 'Variation 2' })).toContainText(`Seed ${REAL_GENERATION_SEEDS[1]}`)

  expect(firstGeneration.input?.prompt).toBe(REAL_PROMPT)
  expect(secondGeneration.input?.prompt).toBe(REAL_PROMPT)
  expect(firstGeneration.input?.duration).toBe(4)
  expect(secondGeneration.input?.duration).toBe(4)
  expect(firstGeneration.input?.bpm).toBe(projectBpm)
  expect(secondGeneration.input?.bpm).toBe(projectBpm)
  expect(firstGeneration.input?.provider).toBe('stable-audio-3')
  expect(secondGeneration.input?.provider).toBe('stable-audio-3')
  expect(firstGeneration.input?.seed).toBe(REAL_GENERATION_SEEDS[0])
  expect(secondGeneration.input?.seed).toBe(REAL_GENERATION_SEEDS[1])
  expect(firstResult.assetId).not.toBe(secondResult.assetId)
  await expect(page.locator('.candidate-card')).toHaveCount(2)

  await auditionCandidate(page, 'Variation 1')
  const selectedCandidate = await auditionCandidate(page, 'Variation 2')
  await selectedCandidate.getByRole('button', { name: 'Place at playhead', exact: true }).click()

  const audioClip = page.getByRole('button', { name: /Variation 2, audio region/ })
  await expect(audioClip).toBeVisible()
  const audioControls = page.getByRole('group', { name: 'Variation 2 region controls' })
  const trimEnd = audioControls.getByRole('button', { name: 'Trim end of Variation 2' })
  const audioLabelBeforeTrim = await audioClip.getAttribute('aria-label')
  await trimEnd.focus()
  await trimEnd.press('ArrowLeft')
  await expect.poll(() => audioClip.getAttribute('aria-label')).not.toBe(audioLabelBeforeTrim)
  const trimmedAudioLabel = await audioClip.getAttribute('aria-label')

  const inspector = page.getByLabel('Selected region inspector')
  const fadeIn = inspector.getByRole('slider', { name: 'Fade in' })
  const fadeOut = inspector.getByRole('slider', { name: 'Fade out' })
  const fadeInBefore = await fadeIn.inputValue()
  const fadeOutBefore = await fadeOut.inputValue()
  await fadeIn.focus()
  await fadeIn.press('ArrowRight')
  await fadeOut.focus()
  await fadeOut.press('ArrowRight')
  await expect.poll(() => fadeIn.inputValue()).not.toBe(fadeInBefore)
  await expect.poll(() => fadeOut.inputValue()).not.toBe(fadeOutBefore)
  const editedFadeIn = await fadeIn.inputValue()
  const editedFadeOut = await fadeOut.inputValue()

  await expect(inspector.locator('.provenance-section')).toContainText('stable-audio')
  await expect(inspector.locator('.provenance-section')).toContainText(REAL_MEDIUM_CONTRACT.generation.modelId)
  await expect(inspector.locator('.provenance-section')).toContainText(REAL_PROMPT)

  const transcription = await triggerAndWaitForJob<TranscriptionResult>(
    page,
    '/api/transcribe',
    'transcribe',
    () => inspector.getByRole('button', { name: 'Extract MIDI', exact: true }).click(),
    REAL_MEDIUM_CONTRACT.jobTimeout,
  )
  const transcriptionResult = transcription.job.result!
  assertMuScriptorMedium(transcriptionResult)
  expect(transcriptionResult.notes.length, 'the real extraction must yield at least four editable notes').toBeGreaterThanOrEqual(4)
  const extractionDurationSeconds = parseClipTiming(trimmedAudioLabel).durationBeats * 60 / 120
  const expectedCommittedNotes = transcriptionResult.notes.filter((note) => {
    if (![note.pitch, note.startTime, note.endTime, note.velocity].every(Number.isFinite)) return false
    if (note.endTime - note.startTime <= 1e-6) return false
    return Math.min(extractionDurationSeconds, note.endTime)
      - Math.max(0, note.startTime) > 1e-6
  })

  const midiClip = page.getByRole('button', { name: /Variation 2 · MIDI, midi region/ })
  await expect(midiClip).toBeVisible({ timeout: 15_000 })
  const midiInspector = page.getByLabel('Selected region inspector')
  await expect(midiInspector.locator('.provenance-section')).toContainText('muscriptor')
  await expect(midiInspector.locator('.provenance-section')).toContainText('MuScriptor/muscriptor-medium')
  await expect(midiInspector.locator('.provenance-section')).toContainText(`Model notes${transcriptionResult.notes.length}`)
  await expect(midiInspector.locator('.provenance-section')).toContainText(`Editable notes${expectedCommittedNotes.length}`)
  if (transcriptionResult.notes.length > expectedCommittedNotes.length) {
    await expect(midiInspector.locator('.provenance-section')).toContainText(`Outside source${transcriptionResult.notes.length - expectedCommittedNotes.length} excluded`)
  }

  const notes = page.locator('.piano-note')
  const velocities = page.locator('.velocity-lane button')
  await expect(notes).toHaveCount(expectedCommittedNotes.length)
  await expect(velocities).toHaveCount(expectedCommittedNotes.length)
  const expectedExportVelocities = await velocities.evaluateAll((elements) => elements.map((element) => Number(element.getAttribute('aria-valuenow'))))
  expect(expectedExportVelocities.every((velocity) => Number.isInteger(velocity) && velocity >= 1 && velocity <= 127)).toBe(true)
  const editedNotes: Array<{ label: string; velocity: number }> = []
  for (let index = 0; index < 4; index += 1) {
    const note = notes.nth(index)
    const noteBefore = await note.getAttribute('aria-label')
    const pitchDirection = expectedCommittedNotes[index].pitch >= 127 ? 'ArrowDown' : 'ArrowUp'
    await note.focus()
    await note.press(pitchDirection)
    await expect.poll(() => note.getAttribute('aria-label')).not.toBe(noteBefore)

    const velocity = velocities.nth(index)
    const velocityBefore = Number(await velocity.getAttribute('aria-valuenow'))
    await velocity.focus()
    await velocity.press(velocityBefore >= 127 ? 'ArrowDown' : 'ArrowUp')
    await expect.poll(async () => Number(await velocity.getAttribute('aria-valuenow'))).not.toBe(velocityBefore)
    const editedVelocity = Number(await velocity.getAttribute('aria-valuenow'))
    expectedExportVelocities[index] = editedVelocity
    editedNotes.push({ label: (await note.getAttribute('aria-label'))!, velocity: editedVelocity })
  }
  expect(editedNotes).toHaveLength(4)

  await audioClip.click()
  await inspector.getByRole('button', { name: 'Duplicate', exact: true }).click()
  const duplicate = page.getByRole('button', { name: /Variation 2 copy, audio region/ })
  await expect(duplicate).toBeVisible()
  const duplicateTiming = parseClipTiming(await duplicate.getAttribute('aria-label'))
  const splitBeat = Math.round((duplicateTiming.startBeat + duplicateTiming.durationBeats / 2) * 4) / 4
  await seekToBeat(page, splitBeat)
  await expect(inspector.getByRole('button', { name: 'Split', exact: true })).toBeEnabled()
  await inspector.getByRole('button', { name: 'Split', exact: true }).click()
  await expect(page.getByRole('button', { name: /Variation 2 copy A, audio region/ })).toBeVisible()
  const splitB = page.getByRole('button', { name: /Variation 2 copy B, audio region/ })
  await expect(splitB).toBeVisible()
  const splitLabelBeforeMove = await splitB.getAttribute('aria-label')
  await splitB.focus()
  await splitB.press('ArrowRight')
  await expect.poll(() => splitB.getAttribute('aria-label')).not.toBe(splitLabelBeforeMove)
  const movedSplitLabel = await splitB.getAttribute('aria-label')

  const trackRows = page.locator('.track-row')
  await expect(trackRows).toHaveCount(2)
  await expect(trackRows.first().getByRole('button', { name: 'Select Generated audio track' })).toBeVisible()
  await page.getByRole('button', { name: 'Move Extracted MIDI track up' }).click()
  await expect(trackRows.first().getByRole('button', { name: 'Select Extracted MIDI track' })).toBeVisible()
  const desktopUndo = page.locator('.history-controls').getByRole('button', { name: 'Undo' })
  const desktopRedo = page.locator('.history-controls').getByRole('button', { name: 'Redo' })
  await desktopUndo.click()
  await expect(trackRows.first().getByRole('button', { name: 'Select Generated audio track' })).toBeVisible()
  await desktopRedo.click()
  await expect(trackRows.first().getByRole('button', { name: 'Select Extracted MIDI track' })).toBeVisible()

  const transportLoop = page.locator('.play-controls').getByRole('button', { name: 'Toggle loop' })
  await expect(transportLoop).toHaveAttribute('aria-pressed', 'false')
  await transportLoop.click()
  await expect(transportLoop).toHaveAttribute('aria-pressed', 'true')
  const loopStart = page.getByRole('slider', { name: 'Loop start' })
  const loopEnd = page.getByRole('slider', { name: 'Loop end' })
  const loopStartBefore = await loopStart.getAttribute('aria-valuenow')
  const loopEndBefore = await loopEnd.getAttribute('aria-valuenow')
  await loopStart.focus()
  await loopStart.press('ArrowRight')
  await loopEnd.focus()
  await loopEnd.press('ArrowRight')
  await expect.poll(() => loopStart.getAttribute('aria-valuenow')).not.toBe(loopStartBefore)
  await expect.poll(() => loopEnd.getAttribute('aria-valuenow')).not.toBe(loopEndBefore)
  const editedLoopStart = await loopStart.getAttribute('aria-valuenow')
  const editedLoopEnd = await loopEnd.getAttribute('aria-valuenow')

  const ruler = page.getByRole('slider', { name: 'Arrangement playhead' })
  await page.getByRole('button', { name: 'Return to start' }).click()
  await expect(ruler).toHaveAttribute('aria-valuenow', '0')
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await expect.poll(async () => Number(await ruler.getAttribute('aria-valuenow')), { timeout: 10_000 }).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()

  await waitForDurableSave(page)
  await page.reload()
  await expect(page.getByText('Saved locally · indexeddb')).toBeVisible()
  await expect(page.locator('.candidate-card')).toHaveCount(2)
  await expect(page.locator('.candidate-card').filter({ hasText: 'Variation 1' })).toContainText(`Seed ${REAL_GENERATION_SEEDS[0]}`)
  await expect(page.locator('.candidate-card').filter({ hasText: 'Variation 2' })).toContainText(`Seed ${REAL_GENERATION_SEEDS[1]}`)
  await expect(trackRows).toHaveCount(2)
  await expect(trackRows.first().getByRole('button', { name: 'Select Extracted MIDI track' })).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Loop start' })).toHaveAttribute('aria-valuenow', editedLoopStart!)
  await expect(page.getByRole('slider', { name: 'Loop end' })).toHaveAttribute('aria-valuenow', editedLoopEnd!)
  const persistedSplitLabel = await page.getByRole('button', { name: /Variation 2 copy B, audio region/ }).getAttribute('aria-label')
  expect(parseClipTiming(persistedSplitLabel)).toEqual(parseClipTiming(movedSplitLabel))

  const persistedAudio = page.getByRole('button', { name: /Variation 2, audio region/ })
  expect(parseClipTiming(await persistedAudio.getAttribute('aria-label'))).toEqual(parseClipTiming(trimmedAudioLabel))
  await persistedAudio.click()
  const persistedInspector = page.getByLabel('Selected region inspector')
  await expect(persistedInspector.getByRole('slider', { name: 'Fade in' })).toHaveValue(editedFadeIn)
  await expect(persistedInspector.getByRole('slider', { name: 'Fade out' })).toHaveValue(editedFadeOut)
  await expect(persistedInspector.locator('.provenance-section')).toContainText(REAL_MEDIUM_CONTRACT.generation.modelId)

  await page.getByRole('button', { name: /Variation 2 · MIDI, midi region/ }).click()
  await expect(notes).toHaveCount(expectedCommittedNotes.length)
  for (let index = 0; index < editedNotes.length; index += 1) {
    await expect(notes.nth(index)).toHaveAttribute('aria-label', editedNotes[index].label)
    await expect(velocities.nth(index)).toHaveAttribute('aria-valuenow', String(editedNotes[index].velocity))
  }
  await expect(page.getByLabel('Selected region inspector').locator('.provenance-section')).toContainText('MuScriptor/muscriptor-medium')

  await page.getByRole('banner', { name: 'Project transport' }).getByRole('button', { name: 'Open project menu' }).click()
  const projectDialog = page.getByRole('dialog', { name: 'Project' })
  await expect(projectDialog).toBeVisible()
  const bundleDownloadPromise = page.waitForEvent('download', { timeout: 30_000 })
  await projectDialog.getByRole('button', { name: /Export project bundle/ }).click()
  const bundleDownload = await bundleDownloadPromise
  const bundleFilename = `${evidencePrefix}-project.vibeseq`
  const bundlePath = path.join(EVIDENCE_DIR, bundleFilename)
  await bundleDownload.saveAs(bundlePath)
  const bundleInspection = inspectProjectBundle(await readFile(bundlePath))
  expect(bundleInspection).toMatchObject({
    format: 'vibeseq-project',
    serializationVersion: 1,
    schemaVersion: 4,
    tracks: 2,
    jobs: 3,
    candidates: 2,
  })
  expect(bundleInspection.clips).toBeGreaterThanOrEqual(4)
  expect(bundleInspection.mediaRecords).toBeGreaterThanOrEqual(3)
  expect(bundleInspection.hashesVerified).toBe(bundleInspection.mediaRecords)
  expect([...bundleInspection.jobSeeds].sort((a, b) => a - b)).toEqual([...REAL_GENERATION_SEEDS])
  expect([...bundleInspection.candidateSeeds].sort((a, b) => a - b)).toEqual([...REAL_GENERATION_SEEDS])

  const audioTimings = await page.locator('.timeline-clip.audio .clip-body-control').evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label')))
  const projectEndBeat = Math.max(...audioTimings.map((label) => {
    const timing = parseClipTiming(label)
    return timing.startBeat + timing.durationBeats
  }))

  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await page.getByLabel('Project sample rate').selectOption('44100')
  await page.getByLabel('WAV bit depth').selectOption('24')
  await expect(page.getByText('24-bit PCM · no dither', { exact: true })).toBeVisible()
  await page.getByLabel(/Protect 4× inter-sample peaks/).check()
  const wavDownloadPromise = page.waitForEvent('download', { timeout: 60_000 })
  await page.getByRole('button', { name: /Full mix · WAV/ }).click()
  const wavDownload = await wavDownloadPromise
  const wavFilename = `${evidencePrefix}-full-mix-24bit.wav`
  const wavPath = path.join(EVIDENCE_DIR, wavFilename)
  await wavDownload.saveAs(wavPath)

  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const midiDownloadPromise = page.waitForEvent('download', { timeout: 30_000 })
  await page.getByRole('button', { name: /MIDI structure/ }).click()
  const midiDownload = await midiDownloadPromise
  const midiFilename = `${evidencePrefix}-arrangement.mid`
  const midiPath = path.join(EVIDENCE_DIR, midiFilename)
  await midiDownload.saveAs(midiPath)

  const wav = await readFile(wavPath)
  const wavInspection = inspectWav(wav)
  expect(wavInspection.audioFormat).toBe(1)
  expect(wavInspection.channels).toBe(2)
  expect(wavInspection.sampleRate).toBe(44_100)
  expect(wavInspection.bitDepth).toBe(24)
  expect(wavInspection.blockAlign).toBe(6)
  expect(wavInspection.byteRate).toBe(44_100 * 6)
  expect(wavInspection.dataLength % wavInspection.blockAlign).toBe(0)
  expect(wavInspection.dataLength / wavInspection.blockAlign).toBe(Math.round((projectEndBeat * 60 / projectBpm) * 44_100))
  expect(wav.subarray(wavInspection.dataOffset, wavInspection.dataOffset + wavInspection.dataLength).some((byte) => byte !== 0)).toBe(true)

  const midi = await readFile(midiPath)
  const smfInspection = inspectSmf(midi)
  expect(smfInspection.format).toBe(1)
  expect(smfInspection.declaredTracks).toBe(2)
  expect(smfInspection.parsedTracks).toBe(smfInspection.declaredTracks)
  expect(smfInspection.ppq).toBe(480)
  expect(smfInspection.noteOnPitches).toHaveLength(expectedCommittedNotes.length)
  expect([...smfInspection.noteOnVelocities].sort((a, b) => a - b)).toEqual([...expectedExportVelocities].sort((a, b) => a - b))

  const screenshotFilename = `${evidencePrefix}-final.png`
  await page.screenshot({ path: path.join(EVIDENCE_DIR, screenshotFilename), fullPage: true })
  await writeFile(path.join(EVIDENCE_DIR, `${evidencePrefix}-contract.json`), JSON.stringify({
    run: runLabel,
    target: REAL_MEDIUM_TARGET,
    prompt: REAL_PROMPT,
    bpm: projectBpm,
    configuredSeeds: REAL_GENERATION_SEEDS,
    generation: [firstGeneration, secondGeneration].map(({ input, job }) => ({
      jobId: job.id,
      seed: input?.seed,
      prompt: input?.prompt,
      duration: input?.duration,
      provider: job.result?.provider,
      model: job.result?.model,
      modelId: job.result?.modelId,
      modelRevision: job.result?.modelRevision,
      codeRevision: job.result?.codeRevision,
      runtime: job.result?.runtime,
      route: job.result?.route,
      device: job.result?.device,
    })),
    transcription: {
      jobId: transcription.job.id,
      provider: transcriptionResult.provider,
      model: transcriptionResult.model,
      modelId: transcriptionResult.modelId,
      modelRevision: transcriptionResult.modelRevision,
      codeRevision: transcriptionResult.codeRevision,
      runtime: transcriptionResult.runtime,
      route: transcriptionResult.route,
      device: transcriptionResult.device,
      returnedNotes: transcriptionResult.notes.length,
      extractedNotes: expectedCommittedNotes.length,
      excludedNotes: transcriptionResult.notes.length - expectedCommittedNotes.length,
      editedNotes: editedNotes.length,
    },
    arrangement: {
      trimmedAudioLabel,
      fadeIn: editedFadeIn,
      fadeOut: editedFadeOut,
      movedSplitLabel,
      loopStartBeat: Number(editedLoopStart),
      loopEndBeat: Number(editedLoopEnd),
      firstTrackAfterReload: 'Extracted MIDI',
    },
    exports: {
      projectBundle: { file: bundleFilename, ...bundleInspection },
      wav: { file: wavFilename, ...wavInspection },
      midi: { file: midiFilename, ...smfInspection },
      screenshot: screenshotFilename,
    },
  }, null, 2))
})
