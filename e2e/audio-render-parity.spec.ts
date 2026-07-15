import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

test('offline stereo pan render nulls against Chromium StereoPannerNode', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false')

  const observations: Array<{ sampleRate: number; pan: number; nullPeak: number; nullPeakDbfs: number }> = []
  for (const sampleRate of [44_100, 48_000]) {
    for (const pan of [-1, -0.5, 0, 0.5, 1]) {
      observations.push(await page.evaluate(async ({ sampleRate: rate, pan: panValue }) => {
        const frameCount = 256
        const left = Float32Array.from({ length: frameCount }, (_, frame) => (
          Math.sin((2 * Math.PI * 997 * frame) / rate) * 0.37
        ))
        const right = Float32Array.from({ length: frameCount }, (_, frame) => (
          Math.cos((2 * Math.PI * 431 * frame) / rate) * 0.23
        ))

        const context = new OfflineAudioContext(2, frameCount, rate)
        const buffer = context.createBuffer(2, frameCount, rate)
        buffer.copyToChannel(left, 0)
        buffer.copyToChannel(right, 1)
        const source = context.createBufferSource()
        const panner = context.createStereoPanner()
        source.buffer = buffer
        panner.pan.value = panValue
        source.connect(panner).connect(context.destination)
        source.start(0)
        const live = await context.startRendering()

        const modulePath = '/src/core/audio/mixdown.ts'
        const { renderProjectToPcm } = await import(modulePath) as {
          renderProjectToPcm: (
            project: Record<string, unknown>,
            assets: Map<string, { id: string; sampleRate: number; channelData: Float32Array[] }>,
            options: Record<string, unknown>,
          ) => Promise<{ channelData: Float32Array[] }>
        }
        const createdAt = '2026-07-15T00:00:00.000Z'
        const durationBeats = frameCount / rate
        const project = {
          schemaVersion: 4,
          id: 'browser-pan-parity',
          name: 'Browser pan parity',
          bpm: 60,
          sampleRate: rate,
          timeSignature: { numerator: 4, denominator: 4 },
          arrangement: { overlapPolicy: 'prevent' },
          tracks: [{
            id: 'browser-pan-track',
            name: 'Browser pan track',
            kind: 'audio',
            color: '#f6a84b',
            gain: 1,
            pan: panValue,
            mute: false,
            solo: false,
            clips: [{
              id: 'browser-pan-clip',
              name: 'Browser pan clip',
              kind: 'audio',
              assetId: 'browser-pan-asset',
              startBeat: 0,
              durationBeats,
              offsetBeats: 0,
              timebase: { mode: 'fixed-seconds', sourceBpm: 60 },
              gain: 1,
              fadeIn: 0,
              fadeOut: 0,
              provenance: { source: 'user', createdAt },
            }],
          }],
          loop: { enabled: false, startBeat: 0, endBeat: durationBeats },
          assets: [],
          jobs: [],
          masterGain: 1,
          createdAt,
          updatedAt: createdAt,
        }
        const exported = await renderProjectToPcm(project, new Map([['browser-pan-asset', {
          id: 'browser-pan-asset',
          sampleRate: rate,
          channelData: [left, right],
        }]]), {
          sampleRate: rate,
          fromBeat: 0,
          toBeat: durationBeats,
          channelCount: 2,
          protectPeaks: false,
        })

        let nullPeak = 0
        for (let channel = 0; channel < 2; channel += 1) {
          const liveChannel = live.getChannelData(channel)
          const exportedChannel = exported.channelData[channel]
          for (let frame = 0; frame < frameCount; frame += 1) {
            nullPeak = Math.max(nullPeak, Math.abs(liveChannel[frame] - exportedChannel[frame]))
          }
        }
        return {
          sampleRate: rate,
          pan: panValue,
          nullPeak,
          nullPeakDbfs: 20 * Math.log10(Math.max(nullPeak, Number.EPSILON)),
        }
      }, { sampleRate, pan }))
    }
  }

  for (const observation of observations) {
    expect(observation.nullPeakDbfs, JSON.stringify(observation)).toBeLessThan(-90)
  }
  const report = {
    recordedAt: new Date().toISOString(),
    browser: 'chromium',
    method: 'renderProjectToPcm compared sample-by-sample with OfflineAudioContext StereoPannerNode',
    thresholdDbfs: -90,
    observations,
    worstNullPeakDbfs: Math.max(...observations.map((observation) => observation.nullPeakDbfs)),
  }
  console.log(`STEREO_PAN_NULL ${JSON.stringify(report)}`)
  if (process.env.VIBESEQ_QA_EVIDENCE === '1') {
    const evidenceDirectory = path.resolve('artifacts/qa/2026-07-15-audio-integrity')
    await mkdir(evidenceDirectory, { recursive: true })
    await writeFile(path.join(evidenceDirectory, 'stereo-pan-live-offline-null.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
})
