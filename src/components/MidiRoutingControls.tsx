import {
  createDrumMidiTrackSettings,
  createMelodicMidiTrackSettings,
  MELODIC_MIDI_CHANNELS,
} from '../core'
import type { MidiTrackSettings } from '../types'
import { GENERAL_MIDI_PROGRAM_NAMES } from '../ui/gmPrograms'

type MidiRoutingControlsProps = {
  settings: MidiTrackSettings
  onChange: (settings: MidiTrackSettings) => void
}

export function MidiRoutingControls({ settings, onChange }: MidiRoutingControlsProps) {
  const isDrums = settings.instrument.kind === 'drums'
  return (
    <section className="inspector-section midi-routing" aria-label="MIDI routing">
      <div className="section-label"><span>ROUTING</span></div>
      <label className="routing-field">
        <span>Instrument</span>
        <select
          aria-label="MIDI instrument profile"
          value={settings.instrument.kind}
          onChange={(event) => {
            onChange(event.target.value === 'drums'
              ? createDrumMidiTrackSettings()
              : createMelodicMidiTrackSettings())
          }}
        >
          <option value="melodic">TinySynth · melodic</option>
          <option value="drums">Chaos SF2 · drums</option>
        </select>
      </label>
      <label className="routing-field">
        <span>Channel</span>
        <select
          aria-label="MIDI channel"
          value={settings.channel}
          disabled={isDrums}
          onChange={(event) => {
            if (settings.instrument.kind !== 'melodic') return
            onChange(createMelodicMidiTrackSettings(Number(event.target.value), settings.instrument.program))
          }}
        >
          {isDrums
            ? <option value={9}>10 · percussion</option>
            : MELODIC_MIDI_CHANNELS.map((channel) => (
              <option key={channel} value={channel}>{channel + 1}</option>
            ))}
        </select>
      </label>
      {settings.instrument.kind === 'melodic' && (
        <label className="routing-field">
          <span>Program</span>
          <select
            aria-label="TinySynth program"
            value={settings.instrument.program}
            onChange={(event) => onChange(createMelodicMidiTrackSettings(settings.channel, Number(event.target.value)))}
          >
            {GENERAL_MIDI_PROGRAM_NAMES.map((name, program) => (
              <option key={program} value={program}>{program + 1}. {name}</option>
            ))}
          </select>
        </label>
      )}
      <p className="routing-note">
        {isDrums
          ? 'General MIDI percussion is fixed to channel 10. Four compact Chaos samples cover the kit.'
          : 'Channels are stored in the project and written to Standard MIDI export.'}
      </p>
    </section>
  )
}
