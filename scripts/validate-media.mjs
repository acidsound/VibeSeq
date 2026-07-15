#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

const fail = (message) => {
  throw new Error(message)
}

const ascii = (bytes, offset, length) => bytes.subarray(offset, offset + length).toString('ascii')

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SUPPORTED_PROJECT_SCHEMA_VERSIONS = new Set([1, 2, 3, 4])

const recordValue = (value, path) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path}: expected an object`)
  return value
}

const arrayValue = (value, path) => {
  if (!Array.isArray(value)) fail(`${path}: expected an array`)
  return value
}

const stringValue = (value, path, allowEmpty = false) => {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    fail(`${path}: expected a${allowEmpty ? '' : ' non-empty'} string`)
  }
  return value
}

const numberValue = (value, path) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path}: expected a finite number`)
  return value
}

const booleanValue = (value, path) => {
  if (typeof value !== 'boolean') fail(`${path}: expected a boolean`)
  return value
}

const timestampValue = (value, path) => {
  const timestamp = stringValue(value, path)
  if (!Number.isFinite(Date.parse(timestamp))) fail(`${path}: expected an ISO-compatible timestamp`)
  return timestamp
}

const sha256Value = (value, path) => {
  const hash = stringValue(value, path)
  if (!SHA256_PATTERN.test(hash)) fail(`${path}: expected a lowercase 64-character SHA-256 digest`)
  return hash
}

const uniqueIds = (values, path) => {
  const seen = new Set()
  for (const [index, value] of values.entries()) {
    const id = stringValue(recordValue(value, `${path}[${index}]`).id, `${path}[${index}].id`)
    if (seen.has(id)) fail(`${path}: duplicate id "${id}"`)
    seen.add(id)
  }
  return seen
}

const decodeCanonicalBase64 = (value, path) => {
  const encoded = stringValue(value, path, true)
  if (encoded.length % 4 !== 0 || !BASE64_PATTERN.test(encoded)) {
    fail(`${path}: invalid base64 payload`)
  }
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.toString('base64') !== encoded) fail(`${path}: non-canonical base64 payload`)
  return decoded
}

const collectBinaryEnvelopes = (value, path, binaries) => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectBinaryEnvelopes(entry, `${path}[${index}]`, binaries))
    return
  }
  if (!value || typeof value !== 'object') return
  if (Object.hasOwn(value, '__vibeseqBinary')) {
    if (value.__vibeseqBinary !== true) fail(`${path}.__vibeseqBinary: expected true`)
    if (value.mimeType !== undefined) stringValue(value.mimeType, `${path}.mimeType`, true)
    const decoded = decodeCanonicalBase64(value.base64, `${path}.base64`)
    binaries.set(path, {
      path,
      mimeType: value.mimeType,
      bytes: decoded.length,
      sha256: sha256(decoded),
    })
    return
  }
  Object.entries(value).forEach(([key, entry]) => collectBinaryEnvelopes(entry, `${path}.${key}`, binaries))
}

const validateWav = (bytes, file) => {
  if (bytes.length < 44 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    fail(`${file}: not a RIFF/WAVE file`)
  }

  let format
  let data
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = ascii(bytes, offset, 4)
    const size = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    const end = start + size
    if (end > bytes.length) fail(`${file}: truncated ${id} chunk`)
    if (id === 'fmt ') {
      if (size < 16) fail(`${file}: invalid fmt chunk`)
      format = {
        audioFormat: bytes.readUInt16LE(start),
        channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4),
        byteRate: bytes.readUInt32LE(start + 8),
        blockAlign: bytes.readUInt16LE(start + 12),
        bitDepth: bytes.readUInt16LE(start + 14),
      }
    }
    if (id === 'data') data = { start, size }
    offset = end + (size % 2)
  }

  if (!format || !data) fail(`${file}: missing fmt or data chunk`)
  if (![1, 3].includes(format.audioFormat)) fail(`${file}: unsupported WAV format ${format.audioFormat}`)
  if (![1, 2].includes(format.channels)) fail(`${file}: unsupported channel count ${format.channels}`)
  if (![16, 24, 32].includes(format.bitDepth)) fail(`${file}: unsupported bit depth ${format.bitDepth}`)
  if (format.audioFormat === 3 && format.bitDepth !== 32) fail(`${file}: IEEE float WAV must be 32-bit`)
  const bytesPerSample = format.bitDepth / 8
  const expectedAlign = format.channels * bytesPerSample
  if (format.blockAlign !== expectedAlign) fail(`${file}: invalid block alignment`)
  if (format.byteRate !== format.sampleRate * expectedAlign) fail(`${file}: invalid byte rate`)
  if (data.size % expectedAlign !== 0) fail(`${file}: partial PCM frame`)

  let peak = 0
  let nonSilentSamples = 0
  let fullScaleSamples = 0
  const sampleEnd = data.start + data.size
  for (let offset = data.start; offset < sampleEnd; offset += bytesPerSample) {
    let sample
    if (format.audioFormat === 3 && format.bitDepth === 32) {
      sample = bytes.readFloatLE(offset)
    } else if (format.bitDepth === 16) {
      const signed = bytes.readInt16LE(offset)
      sample = signed / (signed < 0 ? 0x8000 : 0x7fff)
    } else if (format.bitDepth === 24) {
      const unsigned = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
      const signed = unsigned & 0x800000 ? unsigned | 0xff000000 : unsigned
      sample = signed / (signed < 0 ? 0x800000 : 0x7fffff)
    } else {
      const signed = bytes.readInt32LE(offset)
      sample = signed / (signed < 0 ? 0x80000000 : 0x7fffffff)
    }
    if (!Number.isFinite(sample)) fail(`${file}: contains a non-finite sample`)
    const magnitude = Math.abs(sample)
    peak = Math.max(peak, magnitude)
    if (magnitude > 1 / 0x800000) nonSilentSamples += 1
    if (magnitude >= 1) fullScaleSamples += 1
  }

  const frames = data.size / expectedAlign
  return {
    file,
    kind: 'wav',
    valid: true,
    bytes: bytes.length,
    sha256: sha256(bytes),
    audioFormat: format.audioFormat === 3 ? 'IEEE float' : 'PCM',
    channels: format.channels,
    sampleRate: format.sampleRate,
    bitDepth: format.bitDepth,
    frames,
    durationSeconds: frames / format.sampleRate,
    peak,
    nonSilentSamples,
    fullScaleSamples,
  }
}

const validateMidi = (bytes, file) => {
  if (bytes.length < 14 || ascii(bytes, 0, 4) !== 'MThd') fail(`${file}: not a Standard MIDI file`)
  const headerLength = bytes.readUInt32BE(4)
  if (headerLength < 6 || 8 + headerLength > bytes.length) fail(`${file}: invalid MIDI header`)
  const format = bytes.readUInt16BE(8)
  const declaredTracks = bytes.readUInt16BE(10)
  const division = bytes.readUInt16BE(12)
  if (![0, 1, 2].includes(format)) fail(`${file}: unsupported SMF format ${format}`)
  if (division & 0x8000) fail(`${file}: SMPTE time division is outside this validator's product contract`)

  let offset = 8 + headerLength
  let trackCount = 0
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length || ascii(bytes, offset, 4) !== 'MTrk') fail(`${file}: invalid MIDI track chunk`)
    const size = bytes.readUInt32BE(offset + 4)
    offset += 8 + size
    if (offset > bytes.length) fail(`${file}: truncated MIDI track`)
    trackCount += 1
  }
  if (offset !== bytes.length || trackCount !== declaredTracks) fail(`${file}: MIDI track count mismatch`)

  return {
    file,
    kind: 'midi',
    valid: true,
    bytes: bytes.length,
    sha256: sha256(bytes),
    format,
    tracks: trackCount,
    ppq: division,
  }
}

const validatePortableMedia = (value, path, binaries) => {
  const media = recordValue(value, path)
  stringValue(media.id, `${path}.id`)
  const declaredSha256 = sha256Value(media.contentHashSha256, `${path}.contentHashSha256`)
  const binaryPaths = ['blob', 'bytes']
    .filter((key) => media[key] !== undefined)
    .map((key) => `${path}.${key}`)
  if (binaryPaths.length === 0) fail(`${path}: portable media bytes are missing`)

  if (media.integrity !== undefined) {
    const integrity = recordValue(media.integrity, `${path}.integrity`)
    if (!['available', 'missing', 'corrupt', 'unverified'].includes(integrity.state)) {
      fail(`${path}.integrity.state: unsupported value "${String(integrity.state)}"`)
    }
    if (integrity.state === 'missing' || integrity.state === 'corrupt') {
      fail(`${path}.integrity.state: portable media is declared ${integrity.state}`)
    }
    for (const key of ['expectedHashSha256', 'actualHashSha256']) {
      if (integrity[key] === undefined) continue
      const integrityHash = sha256Value(integrity[key], `${path}.integrity.${key}`)
      if (integrityHash !== declaredSha256) {
        fail(`${path}.integrity.${key}: does not match contentHashSha256`)
      }
    }
  }

  for (const binaryPath of binaryPaths) {
    const binary = binaries.get(binaryPath)
    if (!binary) fail(`${binaryPath}: expected a VibeSeq binary envelope`)
    if (binary.sha256 !== declaredSha256) {
      fail(`${binaryPath}: SHA-256 mismatch (declared ${declaredSha256}, actual ${binary.sha256})`)
    }
    binary.declaredSha256 = declaredSha256
    binary.hashVerified = true
  }
}

const validateProjectTrack = (value, path, assetIds, schemaVersion, projectBpm) => {
  const track = recordValue(value, path)
  stringValue(track.id, `${path}.id`)
  stringValue(track.name, `${path}.name`, true)
  if (!['audio', 'midi'].includes(track.kind)) fail(`${path}.kind: expected audio or midi`)
  stringValue(track.color, `${path}.color`)
  const gain = numberValue(track.gain, `${path}.gain`)
  const pan = numberValue(track.pan, `${path}.pan`)
  if (gain < 0) fail(`${path}.gain: expected a non-negative gain`)
  if (pan < -1 || pan > 1) fail(`${path}.pan: expected normalized pan -1..1`)
  booleanValue(track.mute, `${path}.mute`)
  booleanValue(track.solo, `${path}.solo`)
  if (track.kind === 'midi' && track.midi !== undefined) {
    const midi = recordValue(track.midi, `${path}.midi`)
    const channel = numberValue(midi.channel, `${path}.midi.channel`)
    if (!Number.isInteger(channel) || channel < 0 || channel > 15) {
      fail(`${path}.midi.channel: expected a zero-based MIDI channel in range 0..15`)
    }
    const instrument = recordValue(midi.instrument, `${path}.midi.instrument`)
    if (instrument.kind === 'drums') {
      if (channel !== 9) fail(`${path}.midi.channel: drum tracks must use MIDI wire channel 10 (zero-based channel 9)`)
      if (instrument.playbackId !== 'WebAudioFont 128_0_Chaos_sf2_file') {
        fail(`${path}.midi.instrument.playbackId: expected "WebAudioFont 128_0_Chaos_sf2_file"`)
      }
    } else if (instrument.kind === 'melodic') {
      if (channel === 9) fail(`${path}.midi.channel: zero-based channel 9 is reserved for drum tracks`)
      if (instrument.playbackId !== 'WebAudio-TinySynth') {
        fail(`${path}.midi.instrument.playbackId: expected "WebAudio-TinySynth"`)
      }
      const program = numberValue(instrument.program, `${path}.midi.instrument.program`)
      if (!Number.isInteger(program) || program < 0 || program > 127) {
        fail(`${path}.midi.instrument.program: expected a General MIDI program in range 0..127`)
      }
    } else {
      fail(`${path}.midi.instrument.kind: expected drums or melodic`)
    }
  }
  const clips = arrayValue(track.clips, `${path}.clips`)
  uniqueIds(clips, `${path}.clips`)
  for (const [clipIndex, entry] of clips.entries()) {
    const clipPath = `${path}.clips[${clipIndex}]`
    const clip = recordValue(entry, clipPath)
    stringValue(clip.name, `${clipPath}.name`, true)
    if (clip.kind !== track.kind) fail(`${clipPath}.kind: clip kind must match track kind`)
    const startBeat = numberValue(clip.startBeat, `${clipPath}.startBeat`)
    const durationBeats = numberValue(clip.durationBeats, `${clipPath}.durationBeats`)
    const offsetBeats = numberValue(clip.offsetBeats, `${clipPath}.offsetBeats`)
    if (startBeat < 0 || offsetBeats < 0 || durationBeats <= 0) {
      fail(`${clipPath}: invalid clip timing`)
    }
    const clipGain = numberValue(clip.gain, `${clipPath}.gain`)
    const fadeIn = numberValue(clip.fadeIn, `${clipPath}.fadeIn`)
    const fadeOut = numberValue(clip.fadeOut, `${clipPath}.fadeOut`)
    if (clipGain < 0 || fadeIn < 0 || fadeOut < 0) fail(`${clipPath}: gain and fades cannot be negative`)
    if (clip.muted !== undefined) booleanValue(clip.muted, `${clipPath}.muted`)
    const provenance = recordValue(clip.provenance, `${clipPath}.provenance`)
    stringValue(provenance.source, `${clipPath}.provenance.source`)
    timestampValue(provenance.createdAt, `${clipPath}.provenance.createdAt`)
    if (clip.kind === 'audio') {
      const assetId = stringValue(clip.assetId, `${clipPath}.assetId`)
      if (!assetIds.has(assetId)) fail(`${clipPath}.assetId: references missing asset "${assetId}"`)
      if (clip.timebase === undefined && schemaVersion >= 4) {
        fail(`${clipPath}.timebase: expected an explicit Audio timebase`)
      }
      if (clip.timebase !== undefined) {
        const timebase = recordValue(clip.timebase, `${clipPath}.timebase`)
        if (!['fixed-seconds', 'tempo-follow-repitch'].includes(timebase.mode)) {
          fail(`${clipPath}.timebase.mode: unsupported value "${String(timebase.mode)}"`)
        }
        const sourceBpm = numberValue(timebase.sourceBpm, `${clipPath}.timebase.sourceBpm`)
        if (sourceBpm <= 0 || sourceBpm > 1_000) {
          fail(`${clipPath}.timebase.sourceBpm: expected tempo in range 0..1000`)
        }
        if (timebase.mode === 'fixed-seconds' && Math.abs(sourceBpm - projectBpm) > 1e-9) {
          fail(`${clipPath}.timebase: fixed-seconds Audio must be rescaled to the project BPM`)
        }
      }
    } else {
      const notes = arrayValue(clip.notes, `${clipPath}.notes`)
      uniqueIds(notes, `${clipPath}.notes`)
      for (const [noteIndex, entry] of notes.entries()) {
        const notePath = `${clipPath}.notes[${noteIndex}]`
        const note = recordValue(entry, notePath)
        const pitch = numberValue(note.pitch, `${notePath}.pitch`)
        const noteStart = numberValue(note.startBeat, `${notePath}.startBeat`)
        const noteDuration = numberValue(note.durationBeats, `${notePath}.durationBeats`)
        const velocity = numberValue(note.velocity, `${notePath}.velocity`)
        if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) fail(`${notePath}.pitch: expected MIDI pitch 0..127`)
        if (noteStart < 0 || noteDuration <= 0) fail(`${notePath}: invalid note timing`)
        if (velocity < 0 || velocity > 1) fail(`${notePath}.velocity: expected normalized velocity 0..1`)
        if (note.channel !== undefined
          && (!Number.isInteger(note.channel) || note.channel < 0 || note.channel > 15)) {
          fail(`${notePath}.channel: expected MIDI channel 0..15`)
        }
      }
    }
  }
  return clips.length
}

const validateProjectJob = (value, path) => {
  const job = recordValue(value, path)
  stringValue(job.id, `${path}.id`)
  if (!['stable-audio-generation', 'midi-extraction'].includes(job.kind)) {
    fail(`${path}.kind: unsupported job kind "${String(job.kind)}"`)
  }
  if (!['queued', 'running', 'completed', 'failed', 'cancelled'].includes(job.state)) {
    fail(`${path}.state: unsupported job state "${String(job.state)}"`)
  }
  if (!['local-gpu', 'local-cpu', 'colab-t4'].includes(job.computeTarget)) {
    fail(`${path}.computeTarget: unsupported compute target "${String(job.computeTarget)}"`)
  }
  const progress = numberValue(job.progress, `${path}.progress`)
  if (progress < 0 || progress > 1) fail(`${path}.progress: expected progress 0..1`)
  timestampValue(job.createdAt, `${path}.createdAt`)
  timestampValue(job.updatedAt, `${path}.updatedAt`)
  recordValue(job.input, `${path}.input`)
  if (job.output !== undefined) recordValue(job.output, `${path}.output`)
  if (job.error !== undefined) recordValue(job.error, `${path}.error`)
}

const validateProjectAsset = (value, path, binaries) => {
  const asset = recordValue(value, path)
  stringValue(asset.name, `${path}.name`, true)
  stringValue(asset.mimeType, `${path}.mimeType`)
  if (numberValue(asset.durationSeconds, `${path}.durationSeconds`) < 0) {
    fail(`${path}.durationSeconds: expected a non-negative duration`)
  }
  if (asset.sampleRate !== undefined
    && (!Number.isInteger(asset.sampleRate) || asset.sampleRate <= 0)) {
    fail(`${path}.sampleRate: expected a positive integer`)
  }
  if (asset.channelCount !== undefined
    && (!Number.isInteger(asset.channelCount) || asset.channelCount <= 0)) {
    fail(`${path}.channelCount: expected a positive integer`)
  }
  timestampValue(asset.createdAt, `${path}.createdAt`)
  recordValue(asset.provenance, `${path}.provenance`)
  validatePortableMedia(asset, path, binaries)
}

const validateProjectSession = (value, path, binaries) => {
  const session = recordValue(value, path)
  const candidates = arrayValue(session.candidates, `${path}.candidates`)
  uniqueIds(candidates, `${path}.candidates`)
  for (const [index, entry] of candidates.entries()) {
    const candidatePath = `${path}.candidates[${index}]`
    const candidate = recordValue(entry, candidatePath)
    stringValue(candidate.name, `${candidatePath}.name`, true)
    stringValue(candidate.prompt, `${candidatePath}.prompt`, true)
    if (numberValue(candidate.duration, `${candidatePath}.duration`) <= 0) {
      fail(`${candidatePath}.duration: expected a positive duration`)
    }
    stringValue(candidate.provider, `${candidatePath}.provider`)
    stringValue(candidate.device, `${candidatePath}.device`)
    if (candidate.seed !== undefined
      && (!Number.isInteger(candidate.seed) || candidate.seed < 0 || candidate.seed > 0xffff_ffff)) {
      fail(`${candidatePath}.seed: expected an integer in range 0..4294967295`)
    }
    validatePortableMedia(candidate, candidatePath, binaries)
  }

  if (session.activeJob !== undefined && session.activeJob !== null) {
    const activeJob = recordValue(session.activeJob, `${path}.activeJob`)
    stringValue(activeJob.label, `${path}.activeJob.label`, true)
    const job = recordValue(activeJob.job, `${path}.activeJob.job`)
    stringValue(job.id, `${path}.activeJob.job.id`)
    if (!['generate', 'transcribe'].includes(job.kind)) fail(`${path}.activeJob.job.kind: unsupported inference kind`)
    if (!['queued', 'running', 'completed', 'failed', 'cancelled'].includes(job.status)) {
      fail(`${path}.activeJob.job.status: unsupported inference status`)
    }
    const progress = numberValue(job.progress, `${path}.activeJob.job.progress`)
    if (progress < 0 || progress > 1) fail(`${path}.activeJob.job.progress: expected progress 0..1`)
  }
  return candidates.length
}

const validateProjectBundle = (bytes, file) => {
  let serialized
  try {
    serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail(`${file}: project bundle is not valid UTF-8`)
  }

  let document
  try {
    document = JSON.parse(serialized)
  } catch {
    fail(`${file}: invalid project bundle JSON`)
  }

  const rootPath = `${file}: document`
  const envelope = recordValue(document, rootPath)
  if (envelope.format !== 'vibeseq-project') fail(`${rootPath}.format: not a VibeSeq project`)
  if (envelope.serializationVersion !== 1) {
    fail(`${rootPath}.serializationVersion: unsupported VibeSeq serialization version ${String(envelope.serializationVersion)}`)
  }
  stringValue(envelope.checkpointId, `${rootPath}.checkpointId`)
  const savedAt = timestampValue(envelope.savedAt, `${rootPath}.savedAt`)
  const revision = envelope.revision === undefined
    ? Math.max(1, Date.parse(savedAt) * 1_000)
    : numberValue(envelope.revision, `${rootPath}.revision`)
  if (!Number.isSafeInteger(revision) || revision < 1) {
    fail(`${rootPath}.revision: expected a positive safe integer`)
  }

  const binaries = new Map()
  collectBinaryEnvelopes(envelope, rootPath, binaries)

  const projectPath = `${rootPath}.project`
  const project = recordValue(envelope.project, projectPath)
  const schemaVersion = numberValue(project.schemaVersion, `${projectPath}.schemaVersion`)
  if (!Number.isInteger(schemaVersion) || !SUPPORTED_PROJECT_SCHEMA_VERSIONS.has(schemaVersion)) {
    fail(`${projectPath}.schemaVersion: unsupported project schema ${String(project.schemaVersion)}`)
  }
  stringValue(project.id, `${projectPath}.id`)
  stringValue(project.name, `${projectPath}.name`, true)
  const projectBpm = numberValue(project.bpm, `${projectPath}.bpm`)
  if (projectBpm <= 0 || projectBpm > 1_000) fail(`${projectPath}.bpm: expected tempo in range 0..1000`)
  if (schemaVersion > 1 && project.sampleRate === undefined) {
    fail(`${projectPath}.sampleRate: required by project schema ${schemaVersion}`)
  }
  if (project.sampleRate !== undefined && ![44_100, 48_000].includes(project.sampleRate)) {
    fail(`${projectPath}.sampleRate: supported values are 44100 or 48000 Hz`)
  }
  if (project.arrangement !== undefined) {
    const arrangement = recordValue(project.arrangement, `${projectPath}.arrangement`)
    if (arrangement.overlapPolicy !== 'prevent') {
      fail(`${projectPath}.arrangement.overlapPolicy: expected prevent`)
    }
  }
  const signature = recordValue(project.timeSignature, `${projectPath}.timeSignature`)
  const numerator = numberValue(signature.numerator, `${projectPath}.timeSignature.numerator`)
  const denominator = numberValue(signature.denominator, `${projectPath}.timeSignature.denominator`)
  if (!Number.isInteger(numerator) || numerator <= 0) fail(`${projectPath}.timeSignature.numerator: expected a positive integer`)
  if (![1, 2, 4, 8, 16, 32].includes(denominator)) fail(`${projectPath}.timeSignature.denominator: unsupported denominator`)
  const loop = recordValue(project.loop, `${projectPath}.loop`)
  booleanValue(loop.enabled, `${projectPath}.loop.enabled`)
  const loopStart = numberValue(loop.startBeat, `${projectPath}.loop.startBeat`)
  const loopEnd = numberValue(loop.endBeat, `${projectPath}.loop.endBeat`)
  if (loopEnd <= loopStart) fail(`${projectPath}.loop: loop end must be after loop start`)
  if (numberValue(project.masterGain, `${projectPath}.masterGain`) < 0) fail(`${projectPath}.masterGain: expected a non-negative gain`)
  timestampValue(project.createdAt, `${projectPath}.createdAt`)
  timestampValue(project.updatedAt, `${projectPath}.updatedAt`)

  const assets = arrayValue(project.assets, `${projectPath}.assets`)
  const assetIds = uniqueIds(assets, `${projectPath}.assets`)
  assets.forEach((asset, index) => validateProjectAsset(asset, `${projectPath}.assets[${index}]`, binaries))

  const tracks = arrayValue(project.tracks, `${projectPath}.tracks`)
  uniqueIds(tracks, `${projectPath}.tracks`)
  let clipCount = 0
  for (const [index, track] of tracks.entries()) {
    clipCount += validateProjectTrack(
      track,
      `${projectPath}.tracks[${index}]`,
      assetIds,
      schemaVersion,
      projectBpm,
    )
  }

  const jobs = arrayValue(project.jobs, `${projectPath}.jobs`)
  uniqueIds(jobs, `${projectPath}.jobs`)
  jobs.forEach((job, index) => validateProjectJob(job, `${projectPath}.jobs[${index}]`))
  const candidateCount = validateProjectSession(envelope.session, `${rootPath}.session`, binaries)

  const embeddedBinaries = [...binaries.values()]
  const uniqueBinaries = new Map()
  for (const binary of embeddedBinaries) {
    if (!uniqueBinaries.has(binary.sha256)) uniqueBinaries.set(binary.sha256, binary.bytes)
  }

  return {
    file,
    kind: 'vibeseq-project',
    valid: true,
    bytes: bytes.length,
    sha256: sha256(bytes),
    format: envelope.format,
    serializationVersion: envelope.serializationVersion,
    schemaVersion,
    checkpointId: envelope.checkpointId,
    revision,
    projectId: project.id,
    tracks: tracks.length,
    clips: clipCount,
    assets: assets.length,
    jobs: jobs.length,
    candidates: candidateCount,
    embeddedBinaryCount: embeddedBinaries.length,
    embeddedBinaryBytes: embeddedBinaries.reduce((total, binary) => total + binary.bytes, 0),
    uniqueEmbeddedBinaryCount: uniqueBinaries.size,
    uniqueEmbeddedBinaryBytes: [...uniqueBinaries.values()].reduce((total, size) => total + size, 0),
    verifiedBinaryCount: embeddedBinaries.filter((binary) => binary.hashVerified).length,
    embeddedBinaries,
  }
}

const files = process.argv.slice(2)
if (files.length === 0) fail('usage: node scripts/validate-media.mjs <file.wav|file.mid|project.vibeseq> [...]')

const results = []
for (const file of files) {
  const bytes = await readFile(file)
  const extension = extname(file).toLowerCase()
  results.push(extension === '.vibeseq'
    ? validateProjectBundle(bytes, file)
    : extension === '.mid' || extension === '.midi'
      ? validateMidi(bytes, file)
      : validateWav(bytes, file))
}

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
