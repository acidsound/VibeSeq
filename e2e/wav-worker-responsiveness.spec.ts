import { expect, test, type Page } from '@playwright/test';
import { open, stat } from 'node:fs/promises';
import { createProjectCheckpoint, serializeProjectBundle } from '../src/core';
import type { Project } from '../src/types';

const CREATED_AT = '2026-07-15T00:00:00.000Z';
const TEN_MINUTE_WAV_BYTES = 44 + 600 * 44_100 * 2 * 2;

const tenMinuteMidiProject = (): Project => ({
  schemaVersion: 4,
  id: 'worker-responsiveness-project',
  name: 'Worker responsiveness proof',
  bpm: 120,
  sampleRate: 44_100,
  timeSignature: { numerator: 4, denominator: 4 },
  arrangement: { overlapPolicy: 'prevent' },
  tracks: [{
    id: 'midi-track',
    name: 'Ten minute MIDI range',
    kind: 'midi',
    color: '#5dd6d1',
    gain: 0.5,
    pan: 0,
    mute: false,
    solo: false,
    clips: [{
      id: 'midi-clip',
      name: 'Ten minute MIDI range',
      kind: 'midi',
      startBeat: 0,
      durationBeats: 1_200,
      offsetBeats: 0,
      gain: 0.8,
      fadeIn: 0,
      fadeOut: 0,
      notes: [{ id: 'note', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0.8 }],
      provenance: { source: 'user', createdAt: CREATED_AT },
    }],
  }],
  loop: { enabled: false, startBeat: 0, endBeat: 1_200 },
  assets: [],
  jobs: [],
  masterGain: 0.8,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
});

const openStudio = async (page: Page): Promise<void> => {
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByText('Saved locally · indexeddb')).toBeVisible();
};

test('10-minute WAV render stays responsive, reports real work, and can be cancelled', async ({ page }) => {
  test.setTimeout(120_000);
  await openStudio(page);
  const serialized = await serializeProjectBundle(createProjectCheckpoint(
    tenMinuteMidiProject(),
    { candidates: [] },
    { checkpointId: 'worker-responsiveness-checkpoint', savedAt: CREATED_AT },
  ));
  await page.locator('input[accept*=".vibeseq"]').setInputFiles({
    name: 'worker-responsiveness.vibeseq',
    mimeType: 'application/vnd.vibeseq.project+json',
    buffer: Buffer.from(serialized),
  });
  await expect(page.locator('.arrangement-heading h1')).toHaveText('Worker responsiveness proof');

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByLabel('WAV bit depth').selectOption('16');
  let downloadCount = 0;
  page.on('download', () => { downloadCount += 1; });
  await page.getByRole('button', { name: /Full mix · WAV/ }).click();
  const progress = page.getByRole('progressbar', { name: 'WAV export progress' });
  await expect(progress).toBeVisible();
  await page.getByRole('button', { name: 'Cancel render', exact: true }).click();
  await expect(page.getByText('WAV export cancelled', { exact: true })).toBeVisible();
  await expect(progress).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Full mix · WAV/ })).toBeEnabled();
  await page.waitForTimeout(300);
  expect(downloadCount).toBe(0);

  await page.evaluate(() => {
    const target = window as typeof window & {
      __wavHeartbeat?: { last: number; maxGap: number; ticks: number; running: boolean };
    };
    target.__wavHeartbeat = { last: performance.now(), maxGap: 0, ticks: 0, running: true };
    const tick = (now: number) => {
      const heartbeat = target.__wavHeartbeat;
      if (!heartbeat?.running) return;
      heartbeat.maxGap = Math.max(heartbeat.maxGap, now - heartbeat.last);
      heartbeat.last = now;
      heartbeat.ticks += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const downloadPromise = page.waitForEvent('download', { timeout: 90_000 });
  const renderStartedAt = Date.now();
  await page.getByRole('button', { name: /Full mix · WAV/ }).click();
  await expect(progress).toBeVisible();
  await expect.poll(async () => Number(await progress.getAttribute('aria-valuenow'))).toBeGreaterThan(10);
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();

  const heartbeat = await page.evaluate(() => {
    const target = window as typeof window & {
      __wavHeartbeat?: { last: number; maxGap: number; ticks: number; running: boolean };
    };
    if (!target.__wavHeartbeat) throw new Error('Heartbeat was not initialized');
    target.__wavHeartbeat.running = false;
    return target.__wavHeartbeat;
  });
  expect(heartbeat.ticks).toBeGreaterThan(20);
  expect(heartbeat.maxGap).toBeLessThan(250);

  const fileStats = await stat(downloadPath!);
  expect(fileStats.size).toBe(TEN_MINUTE_WAV_BYTES);
  console.info(`WAV_WORKER_RESPONSIVENESS ${JSON.stringify({
    durationSeconds: 600,
    sampleRate: 44_100,
    bitDepth: 16,
    byteLength: fileStats.size,
    elapsedMs: Date.now() - renderStartedAt,
    animationFrameTicks: heartbeat.ticks,
    maxAnimationFrameGapMs: heartbeat.maxGap,
  })}`);
  const file = await open(downloadPath!, 'r');
  try {
    const header = Buffer.alloc(44);
    await file.read(header, 0, header.length, 0);
    expect(header.subarray(0, 4).toString()).toBe('RIFF');
    expect(header.subarray(8, 12).toString()).toBe('WAVE');
    expect(header.readUInt32LE(24)).toBe(44_100);
    expect(header.readUInt16LE(34)).toBe(16);
  } finally {
    await file.close();
  }
});
