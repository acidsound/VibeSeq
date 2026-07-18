import chaosKickUrl from '../../assets/midi/12836_0_Chaos_sf2_file.mp3?no-inline'
import chaosSnareUrl from '../../assets/midi/12838_0_Chaos_sf2_file.mp3?no-inline'
import chaosClosedHatUrl from '../../assets/midi/12842_0_Chaos_sf2_file.mp3?no-inline'
import chaosOpenHatUrl from '../../assets/midi/12846_0_Chaos_sf2_file.mp3?no-inline'
import { chaosDrumAssetId, type ChaosDrumSampleNote } from './midiInstrumentRender'

export interface BuiltinMidiAssetSource {
  id: string
  note: ChaosDrumSampleNote
  url: string
}

export const BUILTIN_CHAOS_DRUM_ASSETS: readonly BuiltinMidiAssetSource[] = [
  { id: chaosDrumAssetId(36), note: 36, url: chaosKickUrl },
  { id: chaosDrumAssetId(38), note: 38, url: chaosSnareUrl },
  { id: chaosDrumAssetId(42), note: 42, url: chaosClosedHatUrl },
  { id: chaosDrumAssetId(46), note: 46, url: chaosOpenHatUrl },
]

export type BuiltinMidiAssetLoader = (
  context: BaseAudioContext,
  source: BuiltinMidiAssetSource,
) => Promise<AudioBuffer>

/** Fetches and decodes one pinned built-in instrument sample. */
export const decodeBuiltinMidiAsset: BuiltinMidiAssetLoader = async (context, source) => {
  const response = await fetch(source.url, { cache: 'force-cache' })
  if (!response.ok) {
    throw new Error(`Built-in MIDI asset ${source.id} returned HTTP ${response.status}`)
  }
  const bytes = await response.arrayBuffer()
  return context.decodeAudioData(bytes.slice(0))
}
