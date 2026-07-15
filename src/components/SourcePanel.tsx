import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import { AudioLines, CircleStop, Download, FolderInput, Library, Pause, Play, Plus, Search, Shuffle, Sparkles, Trash2, WandSparkles, X } from 'lucide-react'
import { GENERATION_PROMPT_MAX_LENGTH } from '../api/inference'
import { MAX_GENERATION_SEED, parseGenerationSeedDraft, randomGenerationSeed } from '../core/generationSeed'
import type { SoundLibraryItem } from '../core/soundLibrary'
import type { TimeSignature } from '../types'
import { GENERATION_LENGTH_CHOICES, generationLengthChoiceId, generationLengthLabel, parseGenerationLengthChoice, resolveGenerationLength } from '../ui/generationLength'
import type { GenerationLengthChoice } from '../ui/generationLength'
import type { GeneratedCandidate, JobPresentation } from '../ui/types'
import { formatTime, waveformPath } from '../ui/music'

type SourcePanelProps = {
  prompt: string
  promptFocusRequest?: number
  generationLength: GenerationLengthChoice
  seed: number
  bpm: number
  timeSignature: TimeSignature
  candidates: GeneratedCandidate[]
  libraryItems?: SoundLibraryItem[]
  libraryLoading?: boolean
  libraryError?: string | null
  previewingCandidateId: string | null
  previewingLibraryItemId?: string | null
  job: JobPresentation | null
  open: boolean
  onPromptChange: (value: string) => void
  onGenerationLengthChange: (value: GenerationLengthChoice) => void
  onSeedChange: (value: number) => void
  onGenerate: () => void
  onCancel: () => void
  onPlace: (candidate: GeneratedCandidate) => void
  onPreview: (candidate: GeneratedCandidate) => void
  onDownload: (candidate: GeneratedCandidate) => void
  onImport: (file?: File) => void
  onRefreshLibrary?: () => void
  onPlaceLibrary?: (item: SoundLibraryItem) => void
  onPreviewLibrary?: (item: SoundLibraryItem) => void
  onDownloadLibrary?: (item: SoundLibraryItem) => void
  onDeleteLibrary?: (item: SoundLibraryItem) => void
  onClose: () => void
}

type SourceMode = 'generate' | 'import' | 'library'

export function SourcePanel({
  prompt,
  promptFocusRequest = 0,
  generationLength,
  seed,
  bpm,
  timeSignature,
  candidates,
  libraryItems = [],
  libraryLoading = false,
  libraryError = null,
  previewingCandidateId,
  previewingLibraryItemId = null,
  job,
  open,
  onPromptChange,
  onGenerationLengthChange,
  onSeedChange,
  onGenerate,
  onCancel,
  onPlace,
  onPreview,
  onDownload,
  onImport,
  onRefreshLibrary,
  onPlaceLibrary,
  onPreviewLibrary,
  onDownloadLibrary,
  onDeleteLibrary,
  onClose,
}: SourcePanelProps) {
  const [mode, setMode] = useState<SourceMode>('generate')
  const [libraryQuery, setLibraryQuery] = useState('')
  const [seedDraft, setSeedDraft] = useState(() => String(seed))
  const [seedEditing, setSeedEditing] = useState(false)
  const [importDragging, setImportDragging] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const promptFocusPendingRef = useRef(false)
  const importDragDepthRef = useRef(0)
  const skipSeedBlurRef = useRef(false)
  const promptTooLong = prompt.length > GENERATION_PROMPT_MAX_LENGTH
  const visibleLibraryItems = libraryItems.filter((item) => {
    const query = libraryQuery.trim().toLocaleLowerCase()
    if (!query) return true
    return [item.name, item.prompt, item.provider, item.model, item.modelId]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase().includes(query))
  })

  useEffect(() => {
    if (!seedEditing) setSeedDraft(String(seed))
  }, [seed, seedEditing])

  useLayoutEffect(() => {
    if (promptFocusRequest <= 0) return
    promptFocusPendingRef.current = true
    setMode('generate')
  }, [promptFocusRequest])

  useLayoutEffect(() => {
    if (mode !== 'generate' || !promptFocusPendingRef.current) return
    promptFocusPendingRef.current = false
    const input = promptRef.current
    if (!input) return
    input.focus({ preventScroll: true })
    input.setSelectionRange(prompt.length, prompt.length)
  }, [mode, prompt, promptFocusRequest])

  useEffect(() => {
    if (open && mode === 'import') return
    importDragDepthRef.current = 0
    setImportDragging(false)
  }, [mode, open])

  const commitSeed = (rawValue: string) => {
    const next = parseGenerationSeedDraft(rawValue)
    if (next === null) {
      setSeedDraft(String(seed))
      return
    }
    setSeedDraft(String(next))
    if (next !== seed) onSeedChange(next)
  }

  const randomizeSeed = () => {
    const random = randomGenerationSeed()
    const next = random === seed ? (seed === MAX_GENERATION_SEED ? 0 : seed + 1) : random
    setSeedEditing(false)
    setSeedDraft(String(next))
    onSeedChange(next)
  }

  const hasDraggedFile = (event: ReactDragEvent<HTMLDivElement>) => {
    const { dataTransfer } = event
    return Array.from(dataTransfer.types).includes('Files')
      || Array.from(dataTransfer.items).some((item) => item.kind === 'file')
      || dataTransfer.files.length > 0
  }

  const resetImportDrag = () => {
    importDragDepthRef.current = 0
    setImportDragging(false)
  }

  return (
    <aside className={`source-panel panel ${open ? 'is-open' : ''}`} aria-label="Sound source">
      <nav className="source-rail" aria-label="Source modes">
        <button type="button" className={`rail-action ${mode === 'generate' ? 'is-active' : ''}`} aria-current={mode === 'generate' ? 'page' : undefined} onClick={() => setMode('generate')}><Sparkles /><span>Generate</span></button>
        <button type="button" className={`rail-action ${mode === 'import' ? 'is-active' : ''}`} aria-current={mode === 'import' ? 'page' : undefined} onClick={() => setMode('import')}><FolderInput /><span>Import</span></button>
        <button type="button" className={`rail-action ${mode === 'library' ? 'is-active' : ''}`} aria-current={mode === 'library' ? 'page' : undefined} onClick={() => { setMode('library'); onRefreshLibrary?.() }}><Library /><span>Library</span></button>
      </nav>
      <section className="source-content">
        <header className="panel-heading">
          <div><p className="eyebrow">SOURCE</p><h2>{mode === 'generate' ? 'Generate sound' : mode === 'import' ? 'Import audio' : 'Sound Library'}</h2></div>
          <button className="icon-button close-panel" onClick={onClose} aria-label="Close generator"><X /></button>
        </header>

        {mode === 'generate' && <>
        <label className="prompt-field">
          <span>PROMPT</span>
          <textarea ref={promptRef} value={prompt} onChange={(event) => onPromptChange(event.target.value)} maxLength={GENERATION_PROMPT_MAX_LENGTH} aria-describedby="prompt-character-count" aria-invalid={promptTooLong || undefined} />
          <small id="prompt-character-count" className={promptTooLong ? 'is-invalid' : undefined}>{prompt.length} / {GENERATION_PROMPT_MAX_LENGTH} characters{promptTooLong ? ' · prompt is too long' : ''}</small>
        </label>

        <div className="generation-controls">
          <div className="generation-parameters">
            <label><span>LENGTH</span><select value={generationLengthChoiceId(generationLength)} onChange={(event) => onGenerationLengthChange(parseGenerationLengthChoice(event.target.value))}>
              <optgroup label="SFX · SECONDS">
                {GENERATION_LENGTH_CHOICES.filter((choice) => choice.unit === 'seconds').map((choice) => (
                  <option key={generationLengthChoiceId(choice)} value={generationLengthChoiceId(choice)}>{choice.value} sec</option>
                ))}
              </optgroup>
              <optgroup label="MUSICAL · BARS">
                {GENERATION_LENGTH_CHOICES.filter((choice) => choice.unit === 'bars').map((choice) => {
                  const resolved = resolveGenerationLength(choice, bpm, timeSignature)
                  return <option key={generationLengthChoiceId(choice)} value={generationLengthChoiceId(choice)}>{choice.value} {choice.value === 1 ? 'bar' : 'bars'} · {resolved.durationSeconds.toFixed(2)} sec</option>
                })}
              </optgroup>
            </select></label>
            <div className="seed-control">
              <label htmlFor="generation-seed">SEED</label>
              <div className="seed-input-group">
                <input
                  id="generation-seed"
                  aria-label="Generation seed"
                  type="number"
                  min="0"
                  max={MAX_GENERATION_SEED}
                  step="1"
                  inputMode="numeric"
                  value={seedDraft}
                  aria-valuetext={`${seedDraft || seed}, press Enter or leave the field to apply`}
                  title="Press Enter or leave the field to apply"
                  onFocus={() => setSeedEditing(true)}
                  onChange={(event) => setSeedDraft(event.target.value)}
                  onBlur={(event) => {
                    setSeedEditing(false)
                    if (skipSeedBlurRef.current) {
                      skipSeedBlurRef.current = false
                      return
                    }
                    commitSeed(event.currentTarget.value)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitSeed(event.currentTarget.value)
                      setSeedEditing(false)
                      skipSeedBlurRef.current = true
                      event.currentTarget.blur()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      setSeedDraft(String(seed))
                      setSeedEditing(false)
                      skipSeedBlurRef.current = true
                      event.currentTarget.blur()
                    }
                  }}
                />
                <button type="button" className="seed-randomize" onClick={randomizeSeed} aria-label="Randomize generation seed" title="Choose a new random seed">
                  <Shuffle />
                </button>
              </div>
            </div>
          </div>
          <button className="primary-button" onClick={onGenerate} disabled={!prompt.trim() || promptTooLong || Boolean(job)}>
            <WandSparkles />{job ? 'Working…' : 'Generate'}
          </button>
        </div>

        <div className="candidate-header"><span>AUDITION CANDIDATES</span><small>{candidates.length}</small></div>
        <div className="candidate-list">
          {candidates.length === 0 && (
            <div className="empty-candidates"><AudioLines /><p>Your variations stay local.<br />Generate a sound to begin.</p></div>
          )}
          {candidates.map((candidate) => (
            <article className="candidate-card" key={candidate.id}>
              {(() => {
                const hasMedia = Boolean(candidate.blob || candidate.bytes || candidate.assetUrl)
                return <>
              <div className="candidate-title"><strong>{candidate.name}</strong><span>{formatTime(candidate.duration)}</span></div>
              {hasMedia ? <button className={`candidate-waveform ${previewingCandidateId === candidate.id ? 'is-playing' : ''}`} onClick={() => onPreview(candidate)} aria-label={`${previewingCandidateId === candidate.id ? 'Stop previewing' : 'Preview'} ${candidate.name}`} aria-pressed={previewingCandidateId === candidate.id}>
                <span className="preview-icon">{previewingCandidateId === candidate.id ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</span>
                {candidate.peaks ? <span className="candidate-waveform-visual"><svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true"><path d={waveformPath(candidate.peaks)} /></svg></span> : <span className="candidate-media-state">Waveform unavailable</span>}
              </button> : <div className="candidate-waveform candidate-waveform-unavailable" role="note">{candidate.peaks ? <span className="candidate-waveform-visual"><svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true"><path d={waveformPath(candidate.peaks)} /></svg></span> : null}<span className="candidate-media-state">Encoded audio unavailable</span></div>}
              <div className="candidate-meta"><span>{candidate.provider}</span><span>{candidate.model ? `${candidate.model} · ` : ''}{candidate.runtime ?? candidate.device}</span></div>
              {candidate.seed !== undefined && <p className="candidate-seed">Seed {candidate.seed}</p>}
              {candidate.generationLength?.unit === 'bars' && <p className="candidate-length" title="Resolved from the project tempo and meter at submission">{generationLengthLabel(candidate.generationLength)}</p>}
              {candidate.peakProtectionApplied && (
                <p className="candidate-integrity" role="note">
                  Peak protected −{(candidate.peakAttenuationDb ?? 0).toFixed(2)} dB · source peak {(candidate.sourcePeak ?? 0).toFixed(3)}
                </p>
              )}
              {hasMedia && <div className="candidate-actions"><button onClick={() => onPlace(candidate)}><Plus />Place at playhead</button><button onClick={() => onDownload(candidate)} aria-label={`Download ${candidate.name}`}><Download /></button></div>}
                </>
              })()}
            </article>
          ))}
        </div>
        </>}

        {mode === 'import' && (
          <div className="source-import-view">
            <div
              className={`source-import-dropzone ${importDragging ? 'is-dragging' : ''}`}
              role="region"
              aria-label="Import audio drop zone"
              aria-describedby="source-import-drop-help"
              onDragEnter={(event) => {
                if (!hasDraggedFile(event)) return
                event.preventDefault()
                importDragDepthRef.current += 1
                setImportDragging(true)
              }}
              onDragOver={(event) => {
                if (!hasDraggedFile(event)) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'copy'
                setImportDragging(true)
              }}
              onDragLeave={(event) => {
                event.preventDefault()
                importDragDepthRef.current = Math.max(0, importDragDepthRef.current - 1)
                if (importDragDepthRef.current === 0) setImportDragging(false)
              }}
              onDrop={(event) => {
                event.preventDefault()
                const [file] = Array.from(event.dataTransfer.files)
                resetImportDrag()
                if (file) onImport(file)
              }}
            >
              <FolderInput aria-hidden="true" />
              <strong aria-live="polite">{importDragging ? 'Drop to import this audio' : 'Drop one local audio file here'}</strong>
              <p id="source-import-drop-help">Or choose a WAV, MP3, FLAC, or other browser-decodable audio file. Its original encoded bytes stay local.</p>
              <button type="button" className="primary-button" onClick={() => onImport()}><Plus />Choose audio file</button>
            </div>
          </div>
        )}

        {mode === 'library' && (
          <>
            <label className="library-search">
              <Search aria-hidden="true" />
              <span className="sr-only">Search Sound Library</span>
              <input value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="Search name, prompt, model…" aria-label="Search Sound Library" />
            </label>
            <div className="candidate-header"><span>GLOBAL LOCAL SOUNDS</span><small>{visibleLibraryItems.length}</small></div>
            <div className="candidate-list library-list" aria-busy={libraryLoading}>
              {libraryLoading && <div className="empty-candidates" role="status"><Library /><p>Reading the local Sound Library…</p></div>}
              {!libraryLoading && libraryError && <div className="library-error" role="alert"><strong>Library unavailable</strong><p>{libraryError}</p>{onRefreshLibrary && <button type="button" onClick={onRefreshLibrary}>Try again</button>}</div>}
              {!libraryLoading && !libraryError && visibleLibraryItems.length === 0 && (
                <div className="empty-candidates"><Library /><p>{libraryQuery.trim() ? 'No local sounds match this search.' : 'Generated sounds appear here across every local project.'}</p></div>
              )}
              {!libraryLoading && !libraryError && visibleLibraryItems.map((item) => {
                const hasMedia = Boolean(item.blob || item.bytes)
                const previewing = previewingLibraryItemId === item.id
                return <article className="candidate-card library-card" key={item.id}>
                  <div className="candidate-title"><strong>{item.name}</strong><span>{formatTime(item.durationSeconds)}</span></div>
                  {hasMedia && onPreviewLibrary ? <button className={`candidate-waveform ${previewing ? 'is-playing' : ''}`} onClick={() => onPreviewLibrary(item)} aria-label={`${previewing ? 'Stop previewing' : 'Preview'} ${item.name}`} aria-pressed={previewing}>
                    <span className="preview-icon">{previewing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</span>
                    {item.waveform ? <span className="candidate-waveform-visual"><svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true"><path d={waveformPath(item.waveform)} /></svg></span> : <span className="candidate-media-state">Waveform unavailable</span>}
                  </button> : <div className="candidate-waveform candidate-waveform-unavailable" role="note"><span className="candidate-media-state">Encoded audio unavailable</span></div>}
                  <div className="candidate-meta"><span>{item.source}</span><span>{item.provider ?? item.model ?? 'local'}</span></div>
                  {item.prompt && <p className="library-prompt">{item.prompt}</p>}
                  <div className="candidate-actions">
                    {hasMedia && onPlaceLibrary && <button type="button" onClick={() => onPlaceLibrary(item)}><Plus />Place at playhead</button>}
                    <span className="library-secondary-actions">
                      {hasMedia && onDownloadLibrary && <button type="button" onClick={() => onDownloadLibrary(item)} aria-label={`Download ${item.name}`}><Download /></button>}
                      {onDeleteLibrary && <button type="button" className="library-delete" onClick={() => onDeleteLibrary(item)} aria-label={`Delete ${item.name} from Sound Library`}><Trash2 /></button>}
                    </span>
                  </div>
                </article>
              })}
            </div>
          </>
        )}
      </section>
      {job && (
        <div className="job-strip" role="status" aria-live="polite">
          <Sparkles /><span>{job.label}</span>
          <div className="job-progress" role="progressbar" aria-label={job.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.job.progress * 100)}><i style={{ width: `${Math.round(job.job.progress * 100)}%` }} /></div>
          <b>{Math.round(job.job.progress * 100)}%</b>
          <button onClick={onCancel} aria-label="Cancel job"><CircleStop /></button>
        </div>
      )}
    </aside>
  )
}
