import { describe, expect, it } from 'vitest'
import { sha256Media } from './audio/hash'
import { createBlankProject } from './demo'
import {
  deserializeProjectBundle,
  ProjectBundleError,
  serializeProjectBundle,
} from './projectBundle'
import { createProjectCheckpoint } from './projectSerialization'

const portableCheckpoint = async () => {
  const project = createBlankProject({ id: 'portable-project', now: '2026-07-15T00:00:00.000Z' })
  project.name = 'Portable Colab session'
  project.timeSignature = { numerator: 6, denominator: 8 }
  const sourceBytes = Uint8Array.from([82, 73, 70, 70, 1, 2, 3, 4]).buffer
  const sourceHash = await sha256Media(sourceBytes)
  project.assets.push({
    id: 'portable-source',
    name: 'T4 source.wav',
    mimeType: 'audio/wav',
    durationSeconds: 2,
    sampleRate: 44_100,
    channelCount: 1,
    createdAt: project.createdAt,
    bytes: sourceBytes,
    contentHashSha256: sourceHash,
    provenance: { source: 'stable-audio', createdAt: project.createdAt, model: 'stable-audio-3-medium' },
  })
  project.tracks.push({
    id: 'portable-audio-track',
    name: 'Generated audio',
    kind: 'audio',
    color: '#f6a84b',
    gain: 0.9,
    pan: 0,
    mute: false,
    solo: false,
    clips: [{
      id: 'portable-audio-clip',
      name: 'T4 source',
      kind: 'audio',
      startBeat: 0,
      durationBeats: 4,
      offsetBeats: 0,
      timebase: { mode: 'fixed-seconds', sourceBpm: project.bpm },
      assetId: 'portable-source',
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
      provenance: { source: 'stable-audio', createdAt: project.createdAt },
    }],
  })
  project.jobs.push({
    id: 'generation-job',
    kind: 'stable-audio-generation',
    state: 'completed',
    computeTarget: 'colab-t4',
    progress: 1,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    input: { prompt: 'portable break', durationSeconds: 2, seed: 98_765 },
    output: { assetId: 'portable-source', clipId: 'portable-audio-clip', trackId: 'portable-audio-track' },
  })
  const candidateBlob = new Blob(
    [Uint8Array.from([87, 65, 86, 69, 5, 6, 7, 8])],
    { type: 'audio/wav' },
  )
  const candidateHash = await sha256Media(candidateBlob)
  return createProjectCheckpoint(project, {
    candidates: [{
      id: 'portable-candidate',
      name: 'Unplaced variation',
      prompt: 'portable break',
      duration: 2,
      seed: 98_765,
      provider: 'stable-audio-3',
      device: 'cuda',
      modelId: 'stabilityai/stable-audio-3-medium',
      mimeType: 'audio/wav',
      blob: candidateBlob,
      contentHashSha256: candidateHash,
      jobId: 'generation-job',
    }],
    activeJob: {
      label: 'Extracting MIDI structure',
      job: {
        id: 'transcription-job',
        kind: 'transcribe',
        status: 'running',
        progress: 0.45,
        result: { queue: 'colab-t4' },
      },
    },
  }, { checkpointId: 'portable-checkpoint', savedAt: '2026-07-15T00:00:01.000Z' })
}

describe('portable .vibeseq project bundles', () => {
  it('round-trips project, meter, jobs, session candidates, active job, and binary media', async () => {
    const checkpoint = await portableCheckpoint()
    const restored = await deserializeProjectBundle(await serializeProjectBundle(checkpoint))

    expect(restored.checkpointId).toBe('portable-checkpoint')
    expect(restored.revision).toBe(checkpoint.revision)
    expect(restored.project.name).toBe('Portable Colab session')
    expect(restored.project.timeSignature).toEqual({ numerator: 6, denominator: 8 })
    expect(restored.project.jobs[0]).toMatchObject({ id: 'generation-job', computeTarget: 'colab-t4' })
    expect(restored.project.jobs[0].input.seed).toBe(98_765)
    expect([...new Uint8Array(restored.project.assets[0].bytes!)]).toEqual([82, 73, 70, 70, 1, 2, 3, 4])
    expect(restored.project.assets[0].integrity?.state).toBe('available')
    expect([...new Uint8Array(await restored.session.candidates[0].blob!.arrayBuffer())]).toEqual([87, 65, 86, 69, 5, 6, 7, 8])
    expect(restored.session.candidates[0].integrity?.state).toBe('available')
    expect(restored.session.candidates[0].seed).toBe(98_765)
    expect(restored.session.activeJob?.job).toMatchObject({
      id: 'transcription-job',
      status: 'running',
      progress: 0.45,
      result: { queue: 'colab-t4' },
    })
  })

  it('establishes a content hash for valid legacy media before export', async () => {
    const checkpoint = await portableCheckpoint()
    delete checkpoint.project.assets[0].contentHashSha256
    delete checkpoint.session.candidates[0].contentHashSha256

    const restored = await deserializeProjectBundle(await serializeProjectBundle(checkpoint))
    expect(restored.project.assets[0].contentHashSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(restored.session.candidates[0].contentHashSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(restored.project.assets[0].integrity?.state).toBe('available')
    expect(restored.session.candidates[0].integrity?.state).toBe('available')
  })

  it('rejects valid-base64 media tampering during import', async () => {
    const serialized = await serializeProjectBundle(await portableCheckpoint())
    const document = JSON.parse(serialized) as {
      project: { assets: Array<{ bytes: { base64: string } }> }
    }
    const payload = document.project.assets[0].bytes.base64
    document.project.assets[0].bytes.base64 = `${payload[0] === 'A' ? 'B' : 'A'}${payload.slice(1)}`

    await expect(deserializeProjectBundle(JSON.stringify(document))).rejects.toMatchObject({
      name: 'ProjectBundleError',
      code: 'media-corrupt',
    })
  })

  it('blocks export when any claimed portable media is missing', async () => {
    const checkpoint = await portableCheckpoint()
    delete checkpoint.session.candidates[0].blob
    delete checkpoint.session.candidates[0].bytes
    await expect(serializeProjectBundle(checkpoint)).rejects.toBeInstanceOf(ProjectBundleError)
    await expect(serializeProjectBundle(checkpoint)).rejects.toThrow(/session\.candidates\[0\].*missing/i)
  })

  it('does not rehabilitate media already isolated as corrupt', async () => {
    const checkpoint = await portableCheckpoint()
    checkpoint.project.assets[0].integrity = {
      state: 'corrupt',
      expectedHashSha256: checkpoint.project.assets[0].contentHashSha256,
      message: 'Previously isolated after a failed identity check.',
    }
    await expect(serializeProjectBundle(checkpoint)).rejects.toMatchObject({
      name: 'ProjectBundleError',
      code: 'media-corrupt',
    })
  })
})
