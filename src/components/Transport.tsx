import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  Download,
  Grid3X3,
  Menu,
  Pause,
  Play,
  Redo2,
  Repeat2,
  Settings2,
  SkipBack,
  Square,
  Undo2,
} from 'lucide-react'
import type { InferenceHealth } from '../api/inference'
import { beatToBarsBeatsTicks } from '../core'
import type { Project } from '../types'
import { presentTransportEngine } from '../ui/engineHealth'
import { SNAP_GRID_OPTIONS, type SnapGrid } from '../ui/snapGrid'

type TransportProps = {
  project: Project
  playheadBeat: number
  playing: boolean
  snapGrid: SnapGrid
  canUndo: boolean
  canRedo: boolean
  health: InferenceHealth | null
  generationProvider: string
  masterLevel: number
  onTogglePlay: () => void
  onStop: () => void
  onSeekStart: () => void
  onToggleLoop: () => void
  onSnapGridChange: (grid: SnapGrid) => void
  onUndo: () => void
  onRedo: () => void
  /** Return false when the edit is synchronously rejected (for example, by overlap preflight). */
  onBpmChange: (bpm: number) => boolean | void
  onExport: () => void
  onOpenProject: () => void
  onOpenSettings: () => void
}

export function Transport({
  project,
  playheadBeat,
  playing,
  snapGrid,
  canUndo,
  canRedo,
  health,
  generationProvider,
  masterLevel,
  onTogglePlay,
  onStop,
  onSeekStart,
  onToggleLoop,
  onSnapGridChange,
  onUndo,
  onRedo,
  onBpmChange,
  onExport,
  onOpenProject,
  onOpenSettings,
}: TransportProps) {
  const position = beatToBarsBeatsTicks(playheadBeat, project.timeSignature)
  const engine = presentTransportEngine(health, generationProvider)
  const [tempoDraft, setTempoDraft] = useState(() => project.bpm.toFixed(1))
  const [tempoEditing, setTempoEditing] = useState(false)
  const skipTempoBlurRef = useRef(false)

  useEffect(() => {
    if (!tempoEditing) setTempoDraft(project.bpm.toFixed(1))
  }, [project.bpm, tempoEditing])

  const commitTempo = (rawValue: string) => {
    const parsed = Number.parseFloat(rawValue)
    if (!Number.isFinite(parsed)) {
      setTempoDraft(project.bpm.toFixed(1))
      return
    }
    const next = Math.round(Math.max(30, Math.min(300, parsed)) * 10) / 10
    if (Math.abs(next - project.bpm) <= 1e-9) {
      setTempoDraft(next.toFixed(1))
      return
    }
    const accepted = onBpmChange(next)
    setTempoDraft(accepted === false ? project.bpm.toFixed(1) : next.toFixed(1))
  }

  return (
    <header className="transport" aria-label="Project transport">
      <div className="brand-block">
        <button className="brand-mark" onClick={onOpenProject} aria-label="Open project menu"><Menu /></button>
        <div className="wordmark">VibeSeq</div>
        <button className="project-name" onClick={onOpenProject}><span>{project.name}</span><ChevronDown /></button>
      </div>

      <div className="history-controls transport-section">
        <button className="icon-button" onClick={onUndo} disabled={!canUndo} aria-label="Undo"><Undo2 /></button>
        <button className="icon-button" onClick={onRedo} disabled={!canRedo} aria-label="Redo"><Redo2 /></button>
      </div>

      <div className="play-controls transport-section">
        <button className="icon-button" onClick={onSeekStart} aria-label="Return to start"><SkipBack /></button>
        <button className={`play-button ${playing ? 'is-playing' : ''}`} onClick={onTogglePlay} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause /> : <Play fill="currentColor" />}
        </button>
        <button className="icon-button" onClick={onStop} aria-label="Stop"><Square fill="currentColor" /></button>
        <button className={`icon-button ${project.loop.enabled ? 'is-active' : ''}`} onClick={onToggleLoop} aria-label="Toggle loop" aria-pressed={project.loop.enabled}><Repeat2 /></button>
      </div>

      <div className="position-block transport-section" aria-label="Play position">
        <span>{String(position.bar).padStart(3, '0')}</span>
        <i />
        <span>{String(position.beat).padStart(2, '0')}</span>
        <i />
        <span>{String(position.tick).padStart(3, '0')}</span>
        <small>BAR · BEAT · TICK</small>
      </div>

      <label className="tempo-block transport-section">
        <input
          aria-label="Tempo"
          type="number"
          min="30"
          max="300"
          step="0.1"
          inputMode="decimal"
          enterKeyHint="done"
          value={tempoDraft}
          aria-valuetext={`${tempoDraft || project.bpm.toFixed(1)} BPM, press Enter or leave the field to apply`}
          title="Press Enter or leave the field to apply"
          onFocus={() => setTempoEditing(true)}
          onChange={(event) => setTempoDraft(event.target.value)}
          onBlur={(event) => {
            setTempoEditing(false)
            if (skipTempoBlurRef.current) {
              skipTempoBlurRef.current = false
              return
            }
            commitTempo(event.currentTarget.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitTempo(event.currentTarget.value)
              setTempoEditing(false)
              skipTempoBlurRef.current = true
              event.currentTarget.blur()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setTempoDraft(project.bpm.toFixed(1))
              setTempoEditing(false)
              skipTempoBlurRef.current = true
              event.currentTarget.blur()
            }
          }}
        />
        <small>BPM</small>
      </label>

      <div className="meter-block transport-section" role="meter" aria-label="Master peak level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(masterLevel * 100)}>
        <span style={{ '--meter': `${Math.round(masterLevel * 100)}%` } as React.CSSProperties} />
      </div>

      <label className={`snap-block transport-section ${snapGrid !== 'free' ? 'is-active' : ''}`}>
        <Grid3X3 aria-hidden="true" />
        <select
          aria-label="Snap grid"
          value={snapGrid}
          onChange={(event) => onSnapGridChange(event.target.value as SnapGrid)}
        >
          {SNAP_GRID_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <small>{snapGrid === 'free' ? 'FREE' : 'SNAP'}</small>
      </label>

      <button className="engine-badge" onClick={onOpenSettings} title={engine.title} aria-label={`Engine settings · ${engine.label} · ${engine.ready ? 'ready' : 'not ready'}`}>
        <span className={`status-dot ${engine.ready ? 'online' : ''}`} aria-hidden="true" />
        <span>{engine.label}</span>
        <ChevronDown />
      </button>

      <div className="transport-actions">
        <button className="icon-button desktop-only" onClick={onExport} aria-label="Export"><Download /></button>
        <button className="icon-button" onClick={onOpenSettings} aria-label="Engine settings"><Settings2 /></button>
      </div>
      <button className="icon-button mobile-menu" onClick={onOpenProject} aria-label="Open project menu"><Menu /></button>
    </header>
  )
}
