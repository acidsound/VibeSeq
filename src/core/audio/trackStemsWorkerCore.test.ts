import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createDemoProject } from '../demo';
import { executeTrackStemsWorkerRequest, type TrackStemsManifest } from './trackStemsWorkerCore';

describe('track stems worker core', () => {
  it('packages uniquely named, project-aligned WAV stems and a truthful manifest', async () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z', name: 'Stem Test' });
    const sourceTracks = project.tracks.filter((track) => track.kind === 'midi');
    project.assets = [];
    project.tracks = sourceTracks.map((track, index) => {
      const copy = structuredClone(track);
      copy.id = `duplicate-name-${index}`;
      copy.name = 'Same / Name';
      copy.mute = index === 0;
      copy.solo = index === 1;
      copy.clips = copy.clips.map((clip) => clip.kind === 'midi' ? ({
        ...clip,
        id: `${clip.id}-${index}`,
        startBeat: 0,
        durationBeats: 1,
        notes: clip.notes.filter((note) => note.startBeat < 1).map((note) => ({ ...note, id: `${note.id}-${index}` })),
      }) : clip);
      return copy;
    });
    const progress: number[] = [];

    const result = await executeTrackStemsWorkerRequest({
      project,
      assets: [],
      options: { sampleRate: 44_100, bitDepth: 16, protectPeaks: true },
    }, (update) => progress.push(update.progress));
    const files = unzipSync(new Uint8Array(result.zip));
    const wavNames = Object.keys(files).filter((name) => name.endsWith('.wav')).sort();

    expect(wavNames).toEqual(['track-01-Same-Name.wav', 'track-02-Same-Name.wav']);
    expect(files[`${wavNames[0]}`].slice(0, 4)).toEqual(new TextEncoder().encode('RIFF'));
    expect(files[wavNames[0]].byteLength).toBe(files[wavNames[1]].byteLength);
    expect(files[wavNames[0]].slice(44).some((byte) => byte !== 0)).toBe(true);
    expect(files[wavNames[1]].slice(44).some((byte) => byte !== 0)).toBe(true);

    const manifest = JSON.parse(strFromU8(files['manifest.json'])) as TrackStemsManifest;
    expect(manifest).toMatchObject({
      schema: 'vibeseq-track-stems',
      version: 1,
      project: { id: project.id, name: 'Stem Test', bpm: 118 },
      arrangement: { fromBeat: 0, toBeat: 1 },
      format: { sampleRate: 44_100, bitDepth: 16, channels: 2, peakProtection: true },
    });
    expect(manifest.tracks).toHaveLength(2);
    expect(manifest.tracks[0]).toMatchObject({
      filename: 'track-01-Same-Name.wav',
      mutedInArrangement: true,
      soloInArrangement: false,
    });
    expect(manifest.tracks[1]).toMatchObject({
      filename: 'track-02-Same-Name.wav',
      mutedInArrangement: false,
      soloInArrangement: true,
    });
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1])).toBe(true);
  });

  it('rejects a trackless archive rather than downloading an empty ZIP', async () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    project.tracks = [];
    await expect(executeTrackStemsWorkerRequest({ project, assets: [], options: {} }, () => undefined))
      .rejects.toThrow('Add an Audio or MIDI track');
  });
});
