import type { MidiNote, MidiTrack, Project, TimeSignature, Track } from '../../types';
import { getArrangedMidiNotes } from '../clip';
import { DEFAULT_PPQ, getProjectEndBeat } from '../time';
import {
  createDrumMidiTrackSettings,
  createMelodicMidiTrackSettings,
  MIDI_DRUM_CHANNEL,
  resolveMidiTrackSettings,
} from './instrument';

export interface MidiExportOptions {
  ppq?: number;
  fromBeat?: number;
  toBeat?: number;
}

export interface MidiImportOptions {
  now?: Date | string;
  projectName?: string;
}

export interface MidiImportResult {
  format: number;
  ppq: number;
  bpm: number;
  timeSignature: TimeSignature;
  tracks: Track[];
  durationBeats: number;
}

interface MidiByteEvent {
  tick: number;
  priority: number;
  bytes: number[];
}

const uint16 = (value: number): number[] => [(value >>> 8) & 255, value & 255];
const uint32 = (value: number): number[] => [
  (value >>> 24) & 255,
  (value >>> 16) & 255,
  (value >>> 8) & 255,
  value & 255,
];

const ascii = (value: string): number[] => [...value].map((character) => character.charCodeAt(0) & 255);

export function encodeVariableLength(value: number): number[] {
  let remaining = Math.max(0, Math.min(0x0fffffff, Math.round(value)));
  let buffer = remaining & 0x7f;
  const result: number[] = [];
  while ((remaining >>= 7) > 0) {
    buffer <<= 8;
    buffer |= (remaining & 0x7f) | 0x80;
  }
  while (true) {
    result.push(buffer & 255);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return result;
}

const chunk = (name: string, data: readonly number[]): number[] => [...ascii(name), ...uint32(data.length), ...data];

const textBytes = (value: string): number[] => {
  if (typeof TextEncoder !== 'undefined') return [...new TextEncoder().encode(value)];
  return ascii(value);
};

const denominatorPower = (denominator: number): number => Math.max(0, Math.round(Math.log2(denominator)));

const createTrackChunk = (
  track: MidiTrack,
  ppq: number,
  fromBeat: number,
  toBeat: number,
): number[] => {
  const events: MidiByteEvent[] = [];
  const midi = resolveMidiTrackSettings(track);
  const name = textBytes(track.name);
  events.push({ tick: 0, priority: -2, bytes: [0xff, 0x03, ...encodeVariableLength(name.length), ...name] });
  if (midi.instrument.kind === 'melodic') {
    events.push({
      tick: 0,
      priority: -1,
      bytes: [0xc0 | midi.channel, midi.instrument.program],
    });
  }
  for (const clip of track.clips) {
    if (clip.kind !== 'midi' || clip.muted) continue;
    for (const instance of getArrangedMidiNotes(clip, fromBeat, toBeat)) {
      const { note } = instance;
      const start = instance.startBeat;
      const end = start + instance.durationBeats;
      const startTick = Math.max(0, Math.round((start - fromBeat) * ppq));
      const endTick = Math.max(startTick + 1, Math.round((end - fromBeat) * ppq));
      const channel = midi.channel;
      const pitch = Math.max(0, Math.min(127, Math.round(note.pitch)));
      const velocity = Math.max(1, Math.min(127, Math.round(note.velocity * 127)));
      events.push({ tick: startTick, priority: 1, bytes: [0x90 | channel, pitch, velocity] });
      events.push({ tick: endTick, priority: 0, bytes: [0x80 | channel, pitch, 0] });
    }
  }
  events.sort((a, b) => a.tick - b.tick || a.priority - b.priority);
  const bytes: number[] = [];
  let previousTick = 0;
  for (const event of events) {
    bytes.push(...encodeVariableLength(event.tick - previousTick), ...event.bytes);
    previousTick = event.tick;
  }
  bytes.push(0, 0xff, 0x2f, 0);
  return chunk('MTrk', bytes);
};

export function exportMidi(project: Project, options: MidiExportOptions = {}): Uint8Array {
  if (!Number.isFinite(project.bpm) || project.bpm <= 0) throw new RangeError('Project BPM must be positive');
  const requestedPpq = options.ppq ?? DEFAULT_PPQ;
  if (!Number.isFinite(requestedPpq) || requestedPpq <= 0) throw new RangeError('MIDI PPQ must be positive');
  const ppq = Math.max(24, Math.min(0x7fff, Math.round(requestedPpq)));
  const fromBeat = Math.max(0, options.fromBeat ?? 0);
  const toBeat = Math.max(fromBeat, options.toBeat ?? getProjectEndBeat(project.tracks));
  const midiTracks = project.tracks.filter((track) => track.kind === 'midi');
  const microsecondsPerQuarter = Math.max(1, Math.min(0xffffff, Math.round(60_000_000 / project.bpm)));
  const signature = project.timeSignature;
  const metronomeClocks = Math.max(1, Math.round((24 * 4) / signature.denominator));
  const conductor = chunk('MTrk', [
    0,
    0xff,
    0x51,
    3,
    (microsecondsPerQuarter >>> 16) & 255,
    (microsecondsPerQuarter >>> 8) & 255,
    microsecondsPerQuarter & 255,
    0,
    0xff,
    0x58,
    4,
    Math.max(1, Math.min(255, Math.round(signature.numerator))),
    denominatorPower(signature.denominator),
    metronomeClocks,
    8,
    0,
    0xff,
    0x2f,
    0,
  ]);
  const header = chunk('MThd', [...uint16(1), ...uint16(midiTracks.length + 1), ...uint16(ppq)]);
  const trackChunks = midiTracks.flatMap((track) => createTrackChunk(track, ppq, fromBeat, toBeat));
  return new Uint8Array([...header, ...conductor, ...trackChunks]);
}

export function exportMidiBlob(project: Project, options: MidiExportOptions = {}): Blob {
  const bytes = exportMidi(project, options);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: 'audio/midi' });
}

class MidiReader {
  offset = 0;

  constructor(readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  readByte(): number {
    if (this.offset >= this.bytes.length) throw new Error('Unexpected end of MIDI data');
    return this.bytes[this.offset++];
  }

  peekByte(): number {
    if (this.offset >= this.bytes.length) throw new Error('Unexpected end of MIDI data');
    return this.bytes[this.offset];
  }

  readUint16(): number {
    return (this.readByte() << 8) | this.readByte();
  }

  readUint32(): number {
    return ((this.readByte() << 24) | (this.readByte() << 16) | (this.readByte() << 8) | this.readByte()) >>> 0;
  }

  readAscii(length: number): string {
    return Array.from({ length }, () => String.fromCharCode(this.readByte())).join('');
  }

  readBytes(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.bytes.length) throw new Error('Unexpected end of MIDI data');
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  readVariableLength(): number {
    let value = 0;
    for (let count = 0; count < 4; count += 1) {
      const byte = this.readByte();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error('Invalid MIDI variable-length value');
  }
}

interface ParsedTickNote {
  pitch: number;
  channel: number;
  velocity: number;
  startTick: number;
  endTick: number;
}

interface ParsedTrack {
  name?: string;
  notes: ParsedTickNote[];
  programs: Map<number, number>;
  endTick: number;
}

interface ParsedMeta {
  tempo?: { tick: number; microseconds: number };
  signature?: { tick: number; value: TimeSignature };
}

const decodeText = (bytes: Uint8Array): string => {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
  return [...bytes].map((byte) => String.fromCharCode(byte)).join('');
};

const parseTrack = (reader: MidiReader, endOffset: number, meta: ParsedMeta): ParsedTrack => {
  let tick = 0;
  let runningStatus = 0;
  let name: string | undefined;
  const notes: ParsedTickNote[] = [];
  const programs = new Map<number, number>();
  const active = new Map<string, Array<{ startTick: number; velocity: number }>>();
  while (reader.offset < endOffset) {
    tick += reader.readVariableLength();
    let status = reader.peekByte();
    if (status >= 0x80) {
      status = reader.readByte();
      if (status < 0xf0) runningStatus = status;
    } else {
      if (!runningStatus) throw new Error('MIDI running status used before a channel status byte');
      status = runningStatus;
    }

    if (status === 0xff) {
      const type = reader.readByte();
      const payload = reader.readBytes(reader.readVariableLength());
      if (type === 0x03) name = decodeText(payload);
      if (type === 0x51 && payload.length === 3) {
        const microseconds = (payload[0] << 16) | (payload[1] << 8) | payload[2];
        if (microseconds > 0 && (!meta.tempo || tick < meta.tempo.tick)) meta.tempo = { tick, microseconds };
      }
      if (type === 0x58 && payload.length >= 2) {
        const denominator = 2 ** payload[1];
        if (denominator <= 32 && (!meta.signature || tick < meta.signature.tick)) {
          meta.signature = {
            tick,
            value: { numerator: Math.max(1, payload[0]), denominator: denominator as TimeSignature['denominator'] },
          };
        }
      }
      if (type === 0x2f) break;
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      reader.readBytes(reader.readVariableLength());
      continue;
    }
    if (status >= 0xf0) throw new Error(`Unsupported MIDI system status 0x${status.toString(16)}`);

    const eventType = status & 0xf0;
    const channel = status & 0x0f;
    const first = reader.readByte();
    const second = eventType === 0xc0 || eventType === 0xd0 ? 0 : reader.readByte();
    if (eventType === 0xc0 && !programs.has(channel)) {
      programs.set(channel, first);
    } else if (eventType === 0x90 && second > 0) {
      const key = `${channel}:${first}`;
      const queue = active.get(key) ?? [];
      queue.push({ startTick: tick, velocity: second / 127 });
      active.set(key, queue);
    } else if (eventType === 0x80 || (eventType === 0x90 && second === 0)) {
      const key = `${channel}:${first}`;
      const queue = active.get(key);
      const started = queue?.shift();
      if (started) {
        notes.push({
          pitch: first,
          channel,
          velocity: started.velocity,
          startTick: started.startTick,
          endTick: Math.max(started.startTick + 1, tick),
        });
      }
      if (queue?.length === 0) active.delete(key);
    }
  }
  reader.offset = endOffset;
  for (const [key, queue] of active) {
    const [channel, pitch] = key.split(':').map(Number);
    for (const started of queue) {
      notes.push({
        channel,
        pitch,
        velocity: started.velocity,
        startTick: started.startTick,
        endTick: Math.max(started.startTick + 1, tick),
      });
    }
  }
  return { name, notes, programs, endTick: tick };
};

export function importMidi(data: ArrayBuffer | Uint8Array, options: MidiImportOptions = {}): MidiImportResult {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const reader = new MidiReader(bytes);
  if (reader.readAscii(4) !== 'MThd') throw new Error('Not a Standard MIDI File');
  const headerLength = reader.readUint32();
  if (headerLength < 6) throw new Error('Invalid MIDI header');
  const format = reader.readUint16();
  if (format > 2) throw new Error(`Unsupported MIDI format ${format}`);
  const trackCount = reader.readUint16();
  const division = reader.readUint16();
  if (division & 0x8000) throw new Error('SMPTE time division is not supported');
  if (division === 0) throw new Error('MIDI PPQ division must be greater than zero');
  const ppq = division;
  reader.readBytes(headerLength - 6);
  const meta: ParsedMeta = {};
  const parsedTracks: ParsedTrack[] = [];
  for (let index = 0; index < trackCount; index += 1) {
    if (reader.remaining < 8) throw new Error('Missing MIDI track chunk');
    const chunkName = reader.readAscii(4);
    const chunkLength = reader.readUint32();
    const end = reader.offset + chunkLength;
    if (end > bytes.length) throw new Error('Truncated MIDI track chunk');
    if (chunkName === 'MTrk') parsedTracks.push(parseTrack(reader, end, meta));
    else reader.readBytes(chunkLength);
  }
  const timestamp = new Date(options.now ?? Date.now()).toISOString();
  const routedTracks = parsedTracks.flatMap((track, parsedTrackIndex) => {
    const notesByChannel = new Map<number, ParsedTickNote[]>();
    for (const note of track.notes) {
      const channelNotes = notesByChannel.get(note.channel) ?? [];
      channelNotes.push(note);
      notesByChannel.set(note.channel, channelNotes);
    }
    const baseName = track.name?.trim() || `MIDI ${parsedTrackIndex + 1}`;
    return [...notesByChannel.entries()]
      .sort(([left], [right]) => left - right)
      .map(([channel, notes]) => ({
        channel,
        name: notesByChannel.size > 1 ? `${baseName} · Ch ${channel + 1}` : baseName,
        notes,
        program: track.programs.get(channel) ?? 0,
      }));
  });
  const tracks: Track[] = routedTracks
    .map((routed, trackIndex) => {
      const notes: MidiNote[] = routed.notes
        .sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch)
        .map((note, noteIndex) => ({
          id: `midi-note-${trackIndex + 1}-${noteIndex + 1}`,
          pitch: note.pitch,
          channel: note.channel,
          velocity: note.velocity,
          startBeat: note.startTick / ppq,
          durationBeats: (note.endTick - note.startTick) / ppq,
        }));
      const durationBeats = Math.max(1 / ppq, ...notes.map((note) => note.startBeat + note.durationBeats));
      return {
        id: `midi-track-${trackIndex + 1}`,
        name: routed.name,
        kind: 'midi',
        midi: routed.channel === MIDI_DRUM_CHANNEL
          ? createDrumMidiTrackSettings()
          : createMelodicMidiTrackSettings(routed.channel, routed.program),
        color: ['#A98BFF', '#50D6C9', '#FF704D', '#D8FF4F'][trackIndex % 4],
        gain: 0.8,
        pan: 0,
        mute: false,
        solo: false,
        clips: [
          {
            id: `midi-clip-${trackIndex + 1}`,
            name: routed.name,
            kind: 'midi',
            startBeat: 0,
            durationBeats,
            offsetBeats: 0,
            gain: 1,
            fadeIn: 0,
            fadeOut: 0,
            notes,
            provenance: { source: 'import', createdAt: timestamp },
          },
        ],
      } satisfies Track;
    });
  return {
    format,
    ppq,
    bpm: meta.tempo ? 60_000_000 / meta.tempo.microseconds : 120,
    timeSignature: meta.signature?.value ?? { numerator: 4, denominator: 4 },
    tracks,
    durationBeats: Math.max(0, ...tracks.flatMap((track) => track.clips.map((clip) => clip.startBeat + clip.durationBeats))),
  };
}

export function importMidiToProject(data: ArrayBuffer | Uint8Array, options: MidiImportOptions = {}): Project {
  const imported = importMidi(data, options);
  const timestamp = new Date(options.now ?? Date.now()).toISOString();
  return {
    schemaVersion: 4,
    id: `midi-project-${timestamp.replace(/[^0-9]/g, '').slice(0, 14)}`,
    name: options.projectName ?? 'Imported MIDI',
    bpm: imported.bpm,
    sampleRate: 44_100,
    timeSignature: imported.timeSignature,
    arrangement: { overlapPolicy: 'prevent' },
    tracks: imported.tracks,
    loop: { enabled: false, startBeat: 0, endBeat: Math.max(4, imported.durationBeats) },
    assets: [],
    jobs: [],
    masterGain: 0.9,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
