import { useEffect, useState } from 'react'
import {
  ArrowRight,
  AudioLines,
  Copy,
  Gauge,
  GitBranch,
  Link2,
  Music2,
  RefreshCcw,
  Repeat2,
  Scissors,
  Sparkles,
  SlidersHorizontal,
  Unlink2,
  VolumeX,
  WandSparkles,
  X,
} from 'lucide-react'
import type { Clip, MidiTrackSettings, Track } from '../types'
import type { TempoAnalysisResult } from '../core'
import { MidiRoutingControls } from './MidiRoutingControls'
import { RegionPropertiesControls } from './RegionPropertiesControls'
import { TrackPropertiesControls } from './TrackPropertiesControls'

export type InspectorLinkedRegion = {
  clipId: string
  clipName: string
  trackId: string
  trackName: string
}

type InspectorProps = {
  track?: Track
  clip?: Clip
  playheadBeat: number
  bpm: number
  open: boolean
  extracting: boolean
  busy: boolean
  tempoAnalyzing?: boolean
  tempoAnalysis?: TempoAnalysisResult | null
  tempoAnalysisError?: string | null
  audioTransforming?: boolean
  linkedRegion?: InspectorLinkedRegion
  onGain: (gain: number) => void
  onTrackGain: (gain: number) => void
  onTrackPan: (pan: number) => void
  onToggleTrack: (field: 'mute' | 'solo') => void
  onMidiSettings?: (settings: MidiTrackSettings) => void
  onRenameTrack: (name: string) => void
  onDeleteTrack: () => void
  onRenameRegion: (name: string) => void
  onFade: (edge: 'fadeIn' | 'fadeOut', value: number) => void
  onAudioTransform: (pitchSemitones: number, stretchRatio: number) => void
  onToggleClipMute: () => void
  onToggleSourceLoop: () => void
  onExtract: () => void
  onAnalyzeTempo?: () => void
  onCancelTempoAnalysis?: () => void
  onApplyTempo?: (bpm: number) => void
  onOpenLinkedRegion?: (clipId: string, trackId: string) => void
  onReusePrompt?: (prompt: string) => void
  onSplit: () => void
  onDuplicate: () => void
  onDelete: () => void
  onClose: () => void
}

export function Inspector({
  track,
  clip,
  playheadBeat,
  bpm,
  open,
  extracting,
  busy,
  tempoAnalyzing,
  tempoAnalysis,
  tempoAnalysisError,
  audioTransforming,
  linkedRegion,
  onGain,
  onTrackGain,
  onTrackPan,
  onToggleTrack,
  onMidiSettings,
  onRenameTrack,
  onDeleteTrack,
  onRenameRegion,
  onFade,
  onAudioTransform,
  onToggleClipMute,
  onToggleSourceLoop,
  onExtract,
  onAnalyzeTempo,
  onCancelTempoAnalysis,
  onApplyTempo,
  onOpenLinkedRegion,
  onReusePrompt,
  onSplit,
  onDuplicate,
  onDelete,
  onClose,
}: InspectorProps) {
  const appliedPitch = clip?.kind === 'audio' ? clip.transform?.pitchSemitones ?? 0 : 0
  const appliedStretch = clip?.kind === 'audio' ? clip.transform?.stretchRatio ?? 1 : 1
  const [pitchDraft, setPitchDraft] = useState(appliedPitch)
  const [stretchDraft, setStretchDraft] = useState(appliedStretch)
  useEffect(() => {
    setPitchDraft(appliedPitch)
    setStretchDraft(appliedStretch)
  }, [appliedPitch, appliedStretch, clip?.id])

  if (!track) {
    return (
      <aside className={`inspector-panel panel ${open ? 'is-open' : ''}`} aria-label="Inspector">
        <div className="inspector-empty"><GitBranch /><h3>Nothing selected</h3><p>Select a region to see non-destructive controls and provenance.</p></div>
      </aside>
    )
  }
  if (!clip) {
    return (
      <aside className={`inspector-panel panel ${open ? 'is-open' : ''}`} aria-label="Selected track inspector">
        <header className="inspector-heading"><p className="eyebrow">TRACK PROPERTIES</p><button className="icon-button close-panel" onClick={onClose} aria-label="Close inspector"><X /></button></header>
        <div className="inspector-clip"><span style={{ '--clip-color': track.color } as React.CSSProperties}>{track.kind === 'audio' ? <AudioLines /> : <Music2 />}</span><TrackPropertiesControls trackId={track.id} trackName={track.name} description={`${track.kind === 'audio' ? 'Audio track' : 'MIDI track'} · ${track.clips.length} regions`} onRename={onRenameTrack} onDelete={onDeleteTrack} /></div>
        <section className="inspector-section"><div className="section-label"><span>MIX</span></div><label className="parameter-row"><span>Level</span><input type="range" min="0" max="1.25" step="0.01" value={track.gain} aria-valuetext={`${(20 * Math.log10(Math.max(0.001, track.gain))).toFixed(1)} decibels`} onChange={(event) => onTrackGain(Number(event.target.value))} /><output>{(20 * Math.log10(Math.max(0.001, track.gain))).toFixed(1)} dB</output></label><label className="parameter-row"><span>Pan</span><input type="range" min="-1" max="1" step="0.01" value={track.pan} aria-valuetext={Math.abs(track.pan) < 0.01 ? 'Center' : `${Math.round(Math.abs(track.pan) * 100)} percent ${track.pan < 0 ? 'left' : 'right'}`} onChange={(event) => onTrackPan(Number(event.target.value))} /><output>{Math.abs(track.pan) < 0.01 ? 'C' : `${Math.round(Math.abs(track.pan) * 100)}${track.pan < 0 ? 'L' : 'R'}`}</output></label></section>
        {track.kind === 'midi' && onMidiSettings && <MidiRoutingControls settings={track.midi} onChange={onMidiSettings} />}
        <section className="inspector-actions"><div className="action-grid"><button className={track.mute ? 'is-active' : ''} aria-pressed={track.mute} onClick={() => onToggleTrack('mute')}>M · Mute</button><button className={track.solo ? 'is-active' : ''} aria-pressed={track.solo} onClick={() => onToggleTrack('solo')}>S · Solo</button></div></section>
      </aside>
    )
  }
  const isAudio = clip.kind === 'audio'
  const returnedNoteCount = clip.provenance.metadata?.returnedNoteCount
  const committedNoteCount = clip.provenance.metadata?.committedNoteCount
  const droppedOutOfBoundsNoteCount = clip.provenance.metadata?.droppedOutOfBoundsNoteCount
  const recordingLatencyCompensationMs = clip.provenance.metadata?.latencyCompensationMs
  const unfoldedLoopPasses = clip.provenance.metadata?.unfoldedLoopPasses
  const audioPlaybackRate = clip.kind === 'audio' ? bpm / clip.timebase.sourceBpm : 1
  const hasReusablePrompt = isAudio && Boolean(clip.provenance.prompt?.trim())
  const parentClipId = clip.provenance.parentClipId
  const linkedRegionAvailable = Boolean(parentClipId && linkedRegion && onOpenLinkedRegion)
  const transformChanged = Math.abs(pitchDraft - appliedPitch) > 1e-9
    || Math.abs(stretchDraft - appliedStretch) > 1e-9
  const openLinkedRegion = () => {
    if (!linkedRegion || !onOpenLinkedRegion) return
    onOpenLinkedRegion(linkedRegion.clipId, linkedRegion.trackId)
  }
  return (
    <aside className={`inspector-panel panel ${open ? 'is-open' : ''}`} aria-label="Selected region inspector">
      <header className="inspector-heading">
        <p className="eyebrow">{isAudio ? 'AUDIO REGION' : 'MIDI REGION'}</p>
        <button className="icon-button close-panel" onClick={onClose} aria-label="Close inspector"><X /></button>
      </header>
      <div className="inspector-clip">
        <span style={{ '--clip-color': clip.color ?? track.color } as React.CSSProperties}>{isAudio ? <AudioLines /> : <Music2 />}</span>
        <RegionPropertiesControls regionId={clip.id} regionName={clip.name} description={`${track.name} · ${clip.durationBeats.toFixed(2)} beats`} onRename={onRenameRegion} onDelete={onDelete} />
      </div>

      <section className="inspector-section">
        <div className="section-label"><span>REGION</span></div>
        <button
          className={`inspector-toggle-action ${clip.muted ? 'is-muted' : ''}`}
          aria-label={clip.muted ? 'Unmute region' : 'Mute region'}
          aria-pressed={Boolean(clip.muted)}
          onClick={onToggleClipMute}
        >
          <VolumeX />
          <span><b>Region mute</b><small>{clip.muted ? 'Excluded from playback and export' : 'Silence this region without deleting it'}</small></span>
          <strong>{clip.muted ? 'ON' : 'OFF'}</strong>
        </button>
        <button className={`inspector-toggle-action ${clip.sourceLoop ? 'is-active' : ''}`} aria-pressed={Boolean(clip.sourceLoop)} onClick={onToggleSourceLoop}>
          <Repeat2 />
          <span><b>Clip loop</b><small>{clip.sourceLoop ? `${(clip.sourceLoop.cycleLengthBeats * (clip.kind === 'audio' ? clip.transform?.stretchRatio ?? 1 : 1)).toFixed(2)}-beat audible cycle` : 'Repeat this source independently of project cycle'}</small></span>
          <strong>{clip.sourceLoop ? 'ON' : 'OFF'}</strong>
        </button>
        <label className="parameter-row"><span>Gain</span><input type="range" min="0" max="1.5" step="0.01" value={clip.gain} aria-valuetext={`${(20 * Math.log10(Math.max(0.001, clip.gain))).toFixed(1)} decibels`} onChange={(event) => onGain(Number(event.target.value))} /><output>{(20 * Math.log10(Math.max(0.001, clip.gain))).toFixed(1)} dB</output></label>
        {isAudio && <>
          <label className="parameter-row"><span>Fade in</span><input type="range" min="0" max="2" step="0.01" value={clip.fadeIn} aria-valuetext={`${clip.fadeIn.toFixed(2)} seconds`} onChange={(event) => onFade('fadeIn', Number(event.target.value))} /><output>{clip.fadeIn.toFixed(2)} s</output></label>
          <label className="parameter-row"><span>Fade out</span><input type="range" min="0" max="2" step="0.01" value={clip.fadeOut} aria-valuetext={`${clip.fadeOut.toFixed(2)} seconds`} onChange={(event) => onFade('fadeOut', Number(event.target.value))} /><output>{clip.fadeOut.toFixed(2)} s</output></label>
          <div
            className="toggle-row"
            role="note"
            aria-label={clip.timebase.mode === 'fixed-seconds'
              ? 'Fixed seconds, original speed'
              : `Follow tempo with repitch, ${audioPlaybackRate.toFixed(2)} times playback rate`}
          >
            <span>
              <b>{clip.timebase.mode === 'fixed-seconds' ? 'Fixed seconds' : 'Follow tempo · repitch'}</b>
              <small>{clip.timebase.mode === 'fixed-seconds'
                ? 'Source stays at 1× while beat width follows project tempo'
                : `Authored at ${clip.timebase.sourceBpm.toFixed(1)} BPM · tempo follow remains varispeed`}</small>
            </span>
            <strong>{audioPlaybackRate.toFixed(2)}×</strong>
          </div>
          <div className="audio-transform" aria-label="Independent audio pitch and stretch">
            <div className="audio-transform-heading">
              <SlidersHorizontal />
              <span><b>Pitch &amp; stretch</b><small>Signalsmith render · original asset stays immutable</small></span>
            </div>
            <label className="parameter-row"><span>Pitch</span><input type="range" min="-12" max="12" step="1" value={pitchDraft} disabled={audioTransforming} aria-valuetext={`${pitchDraft > 0 ? 'plus ' : ''}${pitchDraft} semitones`} onChange={(event) => setPitchDraft(Number(event.target.value))} /><output>{pitchDraft > 0 ? '+' : ''}{pitchDraft} st</output></label>
            <label className="parameter-row"><span>Stretch</span><input type="range" min="0.125" max="2" step="0.025" value={stretchDraft} disabled={audioTransforming} aria-valuetext={`${stretchDraft.toFixed(3)} times output duration`} onChange={(event) => setStretchDraft(Number(event.target.value))} /><output>{stretchDraft.toFixed(stretchDraft < 1 ? 3 : 2)}×</output></label>
            <div className="action-grid audio-transform-actions">
              <button type="button" disabled={!transformChanged || audioTransforming} onClick={() => onAudioTransform(pitchDraft, stretchDraft)}>{audioTransforming ? 'Rendering…' : 'Apply to clip'}</button>
              <button type="button" disabled={audioTransforming || (appliedPitch === 0 && appliedStretch === 1)} onClick={() => onAudioTransform(0, 1)}>Reset</button>
            </div>
            <p>Stretch changes the region length. Extreme values may produce audible artifacts.</p>
          </div>
          <div className="tempo-analysis" aria-label="Audio tempo detection">
            <button type="button" className="tempo-analysis-trigger" onClick={tempoAnalyzing ? onCancelTempoAnalysis : onAnalyzeTempo}>
              <Gauge />
              <span><b>{tempoAnalyzing ? 'Cancel tempo analysis' : 'Detect tempo from audio'}</b><small>Analyze this region’s decoded PCM in a Worker</small></span>
            </button>
            {tempoAnalysisError && <p className="tempo-analysis-error" role="alert">{tempoAnalysisError}</p>}
            {tempoAnalysis && <div className="tempo-analysis-result" role="status">
              <div><span>ESTIMATE</span><strong>{tempoAnalysis.bpm.toFixed(1)} BPM</strong><small>{Math.round(tempoAnalysis.confidence * 100)}% confidence · {tempoAnalysis.onsetCount} onsets</small></div>
              <div className="tempo-candidates" aria-label="Detected tempo candidates">
                {tempoAnalysis.candidates.map((candidate) => <button type="button" key={candidate.bpm} onClick={() => onApplyTempo?.(candidate.bpm)} aria-label={`Apply ${candidate.bpm.toFixed(1)} BPM to project`}>
                  <b>{candidate.bpm.toFixed(1)}</b><small>{Math.round(candidate.strength * 100)}%</small>
                </button>)}
              </div>
            </div>}
          </div>
        </>}
      </section>

      <section className="inspector-section provenance-section">
        <div className="section-label">
          <span>PROVENANCE</span>
          {linkedRegionAvailable && linkedRegion
            ? <button type="button" className="icon-button" aria-label={`Reveal linked audio region ${linkedRegion.clipName} in Arrangement`} title={`Source region ${parentClipId}`} onClick={openLinkedRegion}><Link2 /></button>
            : parentClipId
              ? <span role="img" aria-label="Linked audio region unavailable" title={`Missing source region ${parentClipId}`}><Unlink2 /></span>
              : null}
        </div>
        <dl>
          <div><dt>Source</dt><dd>{clip.provenance.source}</dd></div>
          {clip.provenance.model && <div><dt>Model</dt><dd>{clip.provenance.model}</dd></div>}
          {typeof recordingLatencyCompensationMs === 'number' && <div><dt>Record compensation</dt><dd>{recordingLatencyCompensationMs.toFixed(1)} ms</dd></div>}
          {typeof unfoldedLoopPasses === 'number' && unfoldedLoopPasses > 1 && <div><dt>Loop take</dt><dd>{unfoldedLoopPasses} passes · unfolded</dd></div>}
          {clip.provenance.prompt && <div className="prompt-provenance">
            <dt className="prompt-provenance-label">
              <span>Prompt</span>
              {hasReusablePrompt && onReusePrompt && <button
                type="button"
                className="icon-button prompt-reuse-button"
                aria-label="Reuse prompt in Generate sound"
                title="Reuse in Generate sound"
                onClick={() => onReusePrompt(clip.provenance.prompt!)}
              ><RefreshCcw /></button>}
            </dt>
            <dd>{clip.provenance.prompt}</dd>
          </div>}
          {parentClipId && <div><dt>Linked region</dt><dd>
            {linkedRegionAvailable && linkedRegion
              ? <button type="button" className="inspector-toggle-action is-active" aria-label={`Go to linked audio region ${linkedRegion.clipName} on ${linkedRegion.trackName} track`} title={`Source region ID: ${parentClipId}`} onClick={openLinkedRegion}>
                  <AudioLines />
                  <span><b>{linkedRegion.clipName}</b><small>{linkedRegion.trackName} · {parentClipId}</small></span>
                  <ArrowRight />
                </button>
              : <div className="inspector-toggle-action is-muted" role="status" aria-label={`Linked audio region unavailable: ${parentClipId}`}>
                  <Unlink2 />
                  <span><b>Source audio unavailable</b><small>{parentClipId}</small></span>
                  <strong>LOST</strong>
                </div>}
          </dd></div>}
          {!isAudio && typeof returnedNoteCount === 'number' && <div><dt>Model notes</dt><dd>{returnedNoteCount}</dd></div>}
          {!isAudio && typeof committedNoteCount === 'number' && <div><dt>Editable notes</dt><dd>{committedNoteCount}</dd></div>}
          {!isAudio && typeof droppedOutOfBoundsNoteCount === 'number' && droppedOutOfBoundsNoteCount > 0 && <div><dt>Outside source</dt><dd>{droppedOutOfBoundsNoteCount} excluded</dd></div>}
        </dl>
      </section>

      <section className="inspector-actions">
        {isAudio && <button className="extract-button" onClick={onExtract} disabled={busy}><WandSparkles />{extracting ? 'Extracting MIDI…' : busy ? 'Inference busy…' : 'Extract MIDI'}</button>}
        <div className="action-grid">
          <button onClick={onSplit} disabled={playheadBeat <= clip.startBeat || playheadBeat >= clip.startBeat + clip.durationBeats}><Scissors />Split</button>
          <button onClick={onDuplicate}><Copy />Duplicate</button>
        </div>
        {isAudio && <p className="extract-note"><Sparkles />Extraction creates a linked MIDI track. Your source audio stays untouched.</p>}
      </section>
    </aside>
  )
}
