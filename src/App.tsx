import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, CircleStop, Download, FileAudio, FileMusic, FolderOpen, HardDrive, Import, Info, Music2, Plus, Repeat2, Sparkles, Trash2, X } from 'lucide-react'
import {
  allProjectAudioAssetIds,
  type AudioWorkletPlaybackEngine,
  analyzeTempoInWorker,
  audioBufferToPcmAsset,
  beatToBarsBeatsTicks,
  beatsPerBar,
  beatsToSeconds,
  BUILTIN_CHAOS_DRUM_ASSETS,
  createBlankProject,
  createMelodicMidiTrackSettings,
  createPlaybackEngine,
  createGlobalSoundLibrary,
  createProjectCheckpoint,
  createProjectPersistence,
  createWorkspaceSaveCoordinator,
  decodeBuiltinMidiAsset,
  deserializeProjectBundle,
  encodeWav,
  exportMidiBlob,
  exportTrackStemsZipInWorker,
  exportWavInWorker,
  extractMonoPcmClipSegment,
  extractWaveformPeaks,
  getArrangedMidiNotes,
  PROJECT_BUNDLE_EXTENSION,
  PROJECT_BUNDLE_MIME_TYPE,
  secondsToBeats,
  serializeProjectBundle,
  serializeProjectCheckpoint,
  sha256Media,
  snapBeat,
  splitClipAtBeat,
  verifyMediaIntegrity,
} from './core'
import { ProjectDurabilityError } from './core'
import type { MidiCrossingNotePolicy, NoteDivision, PersistenceBackend, ProjectCheckpoint, ProjectSessionSnapshot, SoundLibraryItem, TempoAnalysisResult, WavExportProgress } from './core'
import type { AudioAsset, AudioClip, Clip, MediaIntegrity, MidiNote, MidiTrack, MidiTrackSettings, PcmAudioAsset, Project, ProjectSampleRate, ProjectSummary, TimeSignature, Track, TrackKind, WaveformPeakLevel } from './types'
import {
  cancelJob,
  GENERATION_PROMPT_MAX_LENGTH,
  getInferenceHealth,
  InferenceJobTerminalError,
  startGeneration,
  startTranscription,
  waitForJob,
} from './api/inference'
import type { GeneratedAssetResult, InferenceHealth, InferenceJob, TranscriptionResult } from './api/inference'
import { Arrangement, type ArrangementRevealRequest } from './components/Arrangement'
import { ClipCommandMenu } from './components/ClipCommandMenu'
import { DetailEditor } from './components/DetailEditor'
import { EngineDialog } from './components/EngineDialog'
import { ExportDialog } from './components/ExportDialog'
import { Inspector, type InspectorLinkedRegion } from './components/Inspector'
import { MidiSplitDialog } from './components/MidiSplitDialog'
import { MobileNav } from './components/MobileNav'
import { ProjectDeleteDialog } from './components/ProjectDeleteDialog'
import { SourcePanel } from './components/SourcePanel'
import { Transport } from './components/Transport'
import { useProjectHistory } from './hooks/useProjectHistory'
import { useModalFocus } from './hooks/useModalFocus'
import { findAsset, findClip, findClipCollision, findNextAvailableClipStart, moveTrackInOrder } from './ui/music'
import { captureMidiExtractionSnapshot, createExtractedMidiClip, createMidiTrackSettingsForTranscription } from './ui/midiExtraction'
import { resolveGenerationLength } from './ui/generationLength'
import type { GenerationLengthChoice } from './ui/generationLength'
import { applyProjectTempoChange, planProjectTempoChange } from './ui/projectTempo'
import { existingMidiNoteIds, normalizeMidiNoteBatch } from './ui/midiNoteBatch'
import type { MidiNoteBatchEdit } from './ui/midiNoteBatch'
import { AuditionPreviewGate, isAbortError } from './ui/auditionPreview'
import type { GeneratedCandidate, JobPresentation, MobileSurface } from './ui/types'
import { randomGenerationSeed } from './core/generationSeed'
import { generatedCandidateToSoundLibraryItem, soundLibraryCandidateId, soundLibraryItemToCandidate } from './ui/soundLibrary'
import type { AudioSourceDragPayload } from './ui/sourceDrag'
import { generatedClipName } from './ui/generatedClipName'
import { snapGridDivision, snapGridLabel, type SnapGrid } from './ui/snapGrid'
import { prepareWavExport, safeExportFilenamePart } from './ui/wavExportTarget'
import type { WavExportTarget } from './ui/wavExportTarget'

const makeId = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`

const generationSource = (provider: string): 'stable-audio' | 'demo' =>
  provider === 'stable-audio-3' ? 'stable-audio' : 'demo'

const extractionNoteSummary = (returned: number, committed: number): string => {
  const excluded = returned - committed
  return excluded > 0
    ? `${committed} editable notes · ${excluded} outside source bounds excluded`
    : `${committed} editable notes`
}

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

const normalizePeaks = (peaks: GeneratedAssetResult['peaks']): WaveformPeakLevel | undefined => {
  if (!peaks) return undefined
  if (Array.isArray(peaks)) {
    const max = peaks.map((value) => Math.max(0, Number(value)))
    return { samplesPerPeak: 1, max, min: max.map((value) => -value * 0.82), rms: max.map((value) => value * 0.5) }
  }
  return { samplesPerPeak: 1, min: peaks.min, max: peaks.max, rms: peaks.rms }
}

const ACTIVE_PROJECT_KEY = 'vibeseq:active-project-id'

type ClipCommandState = { clipId: string; trackId: string; anchor: { x: number; y: number } }
type PendingMidiSplit = { clipId: string; trackId: string; atBeat: number; affectedNotes: number; onlyKeep: boolean }
type DurabilityIssue = {
  code: 'quota-exceeded' | 'durable-storage-unavailable' | 'save-failed'
  message: string
  requiredBytes?: number
  availableBytes?: number
}

const SUPPORTED_TIME_SIGNATURES = [
  { numerator: 3, denominator: 4 },
  { numerator: 4, denominator: 4 },
  { numerator: 5, denominator: 4 },
  { numerator: 6, denominator: 8 },
  { numerator: 7, denominator: 8 },
  { numerator: 12, denominator: 8 },
] as const satisfies readonly TimeSignature[]

const musicalPositionLabel = (absoluteBeat: number, timeSignature: TimeSignature): string => {
  const position = beatToBarsBeatsTicks(absoluteBeat, timeSignature)
  const sixteenth = Math.floor(position.tick / 120) + 1
  return `${position.bar}|${position.beat}|${sixteenth}`
}

const activeProjectId = (): string => {
  try { return window.localStorage.getItem(ACTIVE_PROJECT_KEY) || 'project-local-default' }
  catch { return 'project-local-default' }
}

const rememberActiveProject = (projectId: string) => {
  try { window.localStorage.setItem(ACTIVE_PROJECT_KEY, projectId) }
  catch { /* The persistence status already discloses restricted storage. */ }
}

const persistenceLabelFor = (backend: PersistenceBackend): string =>
  backend === 'memory' ? 'Session only · durable storage unavailable' : `Saved locally · ${backend}`

const formatStorageBytes = (bytes: number | undefined): string | undefined => {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined
  if (bytes < 1_024) return `${Math.ceil(bytes)} B`
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${(bytes / 1_024 ** 2).toFixed(1)} MB`
}

const sameIntegrity = (left: MediaIntegrity | undefined, right: MediaIntegrity): boolean =>
  left?.state === right.state
  && left.expectedHashSha256 === right.expectedHashSha256
  && left.actualHashSha256 === right.actualHashSha256
  && left.message === right.message

const assertMediaUsable = (label: string, integrity: MediaIntegrity): void => {
  if (integrity.state !== 'missing' && integrity.state !== 'corrupt') return
  throw new Error(`${label}: ${integrity.message ?? `media is ${integrity.state}`}`)
}

const establishMediaIdentity = async (media: Blob): Promise<{
  contentHashSha256: string
  integrity: MediaIntegrity
}> => {
  const contentHashSha256 = await sha256Media(media)
  const integrity = await verifyMediaIntegrity({ blob: media, contentHashSha256 })
  if (integrity.state !== 'available') throw new Error('New media failed its SHA-256 ingestion check')
  return { contentHashSha256, integrity }
}

const verifyCheckpointMedia = async (checkpoint: ProjectCheckpoint): Promise<ProjectCheckpoint> => {
  const verified = structuredClone(checkpoint)
  await Promise.all([
    ...verified.project.assets.map(async (asset) => { asset.integrity = await verifyMediaIntegrity(asset) }),
    ...verified.session.candidates.map(async (candidate) => { candidate.integrity = await verifyMediaIntegrity(candidate) }),
  ])
  return verified
}

function App() {
  const [startupProject] = useState(() => createBlankProject({ id: activeProjectId() }))
  const history = useProjectHistory(startupProject)
  const { project, getCurrentProject, mutate, replace, updateOperational, mutationError, clearMutationError } = history
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null)
  const [arrangementRevealRequest, setArrangementRevealRequest] = useState<ArrangementRevealRequest | null>(null)
  const arrangementRevealSequenceRef = useRef(0)
  const selected = useMemo(() => findClip(project, selectedClipId), [project, selectedClipId])
  const selectedTrack = useMemo(() => selected?.track ?? project.tracks.find((track) => track.id === selectedTrackId), [project, selected, selectedTrackId])
  const linkedParent = findClip(project, selected?.clip.provenance.parentClipId ?? null)
  const linkedRegion: InspectorLinkedRegion | undefined = linkedParent?.clip.kind === 'audio'
    ? {
        clipId: linkedParent.clip.id,
        clipName: linkedParent.clip.name,
        trackId: linkedParent.track.id,
        trackName: linkedParent.track.name,
      }
    : undefined
  const selectedAsset = selected?.clip.assetId ? findAsset(project, selected.clip.assetId) : undefined
  const [playheadBeat, setPlayheadBeat] = useState(0)
  const playheadBeatRef = useRef(0)
  const updatePlayhead = useCallback((beat: number) => {
    playheadBeatRef.current = beat
    setPlayheadBeat(beat)
  }, [])
  const [playing, setPlaying] = useState(false)
  const [meters, setMeters] = useState<{ master: number; tracks: Record<string, number> }>({ master: 0, tracks: {} })
  const [snapGrid, setSnapGrid] = useState<SnapGrid>('bar')
  const lastSnapGridRef = useRef<Exclude<SnapGrid, 'free'>>('bar')
  const snapDivision = snapGridDivision(snapGrid, project.timeSignature)
  const snapping = snapDivision !== null
  const [zoom, setZoom] = useState(1)
  const [prompt, setPrompt] = useState('dusty neo-soul drums, loose pocket, warm tape, 120 BPM')
  const [promptFocusRequest, setPromptFocusRequest] = useState(0)
  const [generationLength, setGenerationLength] = useState<GenerationLengthChoice>({ unit: 'bars', value: 4 })
  const [generationSeed, setGenerationSeed] = useState(() => randomGenerationSeed())
  const [candidates, setCandidates] = useState<GeneratedCandidate[]>([])
  const [soundLibrary] = useState(() => createGlobalSoundLibrary())
  const [libraryItems, setLibraryItems] = useState<SoundLibraryItem[]>([])
  const [libraryLoading, setLibraryLoading] = useState(true)
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [activeJob, setActiveJob] = useState<JobPresentation | null>(null)
  const [tempoAnalysis, setTempoAnalysis] = useState<{ clipId: string; result: TempoAnalysisResult } | null>(null)
  const [tempoAnalysisError, setTempoAnalysisError] = useState<string | null>(null)
  const [tempoAnalyzing, setTempoAnalyzing] = useState(false)
  const activeJobRef = useRef<InferenceJob<unknown> | null>(null)
  const activeAbortRef = useRef<AbortController | null>(null)
  const [health, setHealth] = useState<InferenceHealth | null>(null)
  const [generationProvider, setGenerationProvider] = useState('procedural-demo')
  const [transcriptionProvider, setTranscriptionProvider] = useState('signal-demo')
  const [toast, setToast] = useState<string | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [mixExportProgress, setMixExportProgress] = useState<WavExportProgress | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [projectSummaries, setProjectSummaries] = useState<ProjectSummary[]>([])
  const [projectDeleteTarget, setProjectDeleteTarget] = useState<ProjectSummary | null>(null)
  const [projectDeleting, setProjectDeleting] = useState(false)
  const [sourceOpen, setSourceOpen] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(() => window.matchMedia?.('(min-width: 981px)').matches ?? true)
  const [detailExpanded, setDetailExpanded] = useState(false)
  const [clipCommand, setClipCommand] = useState<ClipCommandState | null>(null)
  const [pendingMidiSplit, setPendingMidiSplit] = useState<PendingMidiSplit | null>(null)
  const [mobileSurface, setMobileSurface] = useState<MobileSurface>('arrange')
  const [persistenceLabel, setPersistenceLabel] = useState('Starting local journal…')
  const [durabilityIssue, setDurabilityIssue] = useState<DurabilityIssue | null>(null)
  const [persistenceReady, setPersistenceReady] = useState(false)
  const [recoveryCheckpoint, setRecoveryCheckpoint] = useState<ProjectCheckpoint | null>(null)
  const [resumeJobId, setResumeJobId] = useState<string | null>(null)
  const [resumeJobAttempt, setResumeJobAttempt] = useState(0)
  const importInputRef = useRef<HTMLInputElement>(null)
  const bundleInputRef = useRef<HTMLInputElement>(null)
  const playbackRef = useRef<AudioWorkletPlaybackEngine | null>(null)
  const mixExportAbortRef = useRef<AbortController | null>(null)
  const tempoAnalysisAbortRef = useRef<AbortController | null>(null)
  const [persistence] = useState(() => createProjectPersistence())
  const persistenceReadyRef = useRef(false)
  const initialProjectIdRef = useRef(project.id)
  const latestProjectRef = useRef(project)
  const latestSessionRef = useRef<ProjectSessionSnapshot>({ candidates, activeJob })
  const recoveryCheckpointRef = useRef<ProjectCheckpoint | null>(recoveryCheckpoint)
  const durabilityIssueEpochRef = useRef(0)
  const [previewCandidateId, setPreviewCandidateId] = useState<string | null>(null)
  const auditionPreviewGateRef = useRef(new AuditionPreviewGate())
  const decodedAssetHashesRef = useRef(new Map<string, string>())
  const shortcutHandlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined)
  const commandTarget = useMemo(() => clipCommand ? findClip(project, clipCommand.clipId) : null, [clipCommand, project])
  const previewingLibraryItemId = useMemo(
    () => libraryItems.find((item) => soundLibraryCandidateId(item.id) === previewCandidateId)?.id ?? null,
    [libraryItems, previewCandidateId],
  )

  latestProjectRef.current = project
  latestSessionRef.current = { candidates, activeJob }
  recoveryCheckpointRef.current = recoveryCheckpoint

  const cancelCandidatePreview = useCallback((updateUi = true) => {
    auditionPreviewGateRef.current.cancel()
    playbackRef.current?.stopAudition()
    if (updateUi) setPreviewCandidateId(null)
  }, [])

  const refreshSoundLibrary = useCallback(async () => {
    setLibraryLoading(true)
    try {
      setLibraryItems(await soundLibrary.list())
      setLibraryError(null)
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : 'The global Sound Library could not be read')
    } finally {
      setLibraryLoading(false)
    }
  }, [soundLibrary])

  useEffect(() => { void refreshSoundLibrary() }, [refreshSoundLibrary])

  const clearDurabilityIssue = useCallback(() => {
    durabilityIssueEpochRef.current += 1
    setDurabilityIssue(null)
  }, [])

  const reportDurabilityIssue = useCallback(async (error: unknown) => {
    const epoch = ++durabilityIssueEpochRef.current
    let requiredBytes: number | undefined
    let availableBytes: number | undefined
    try {
      const checkpoint = createProjectCheckpoint(latestProjectRef.current, latestSessionRef.current)
      requiredBytes = new TextEncoder().encode(await serializeProjectCheckpoint(checkpoint)).byteLength
    } catch {
      // The save error remains primary if the conservative size estimate fails.
    }
    try {
      const estimate = await navigator.storage?.estimate()
      if (estimate?.quota !== undefined && estimate.usage !== undefined) {
        availableBytes = Math.max(0, estimate.quota - estimate.usage)
      }
    } catch {
      // Some privacy modes intentionally hide quota estimates.
    }
    if (durabilityIssueEpochRef.current !== epoch) return
    const code = error instanceof ProjectDurabilityError ? error.code : 'save-failed'
    setDurabilityIssue({
      code,
      message: error instanceof Error ? error.message : 'The current workspace is not durably saved',
      requiredBytes,
      availableBytes,
    })
  }, [])

  const loadPendingRecovery = useCallback(async (
    preferredProjectId?: string,
  ): Promise<ProjectCheckpoint | undefined> => {
    const recoveries = await persistence.listRecoveries()
    const verified = await Promise.all(recoveries.map(verifyCheckpointMedia))
    return verified.find((checkpoint) => checkpoint.project.id === preferredProjectId) ?? verified[0]
  }, [persistence])

  const workspaceSaveCoordinator = useMemo(() => createWorkspaceSaveCoordinator({
    readLatest: () => ({
      project: latestProjectRef.current,
      session: latestSessionRef.current,
    }),
    save: ({ project: latestProject, session }) => persistence.saveWorkspace(latestProject, session),
    onStateChange: (state, error) => {
      if (state === 'saving') setPersistenceLabel('Saving…')
      else if (state === 'saved') {
        const backend = persistence.getBackend()
        setPersistenceLabel(persistenceLabelFor(backend))
        if (backend === 'memory') {
          void reportDurabilityIssue(new ProjectDurabilityError('durable-storage-unavailable', ['memory']))
        } else {
          clearDurabilityIssue()
        }
      }
      else {
        const message = error instanceof Error ? error.message : 'Unknown local storage error'
        setPersistenceLabel(`Save failed · ${message}`)
        void reportDurabilityIssue(error)
      }
    },
  }), [clearDurabilityIssue, persistence, reportDurabilityIssue])

  const flushWorkspaceSave = useCallback((): Promise<ProjectCheckpoint> => {
    if (!persistenceReadyRef.current) {
      return Promise.reject(new Error('The local project journal is not ready'))
    }
    if (recoveryCheckpointRef.current) {
      return Promise.reject(new Error('Resolve the interrupted-save checkpoint before continuing'))
    }
    return workspaceSaveCoordinator.flush()
  }, [workspaceSaveCoordinator])

  const jobComputeTarget = (): 'local-gpu' | 'local-cpu' | 'colab-t4' => {
    if (health?.target?.startsWith('colab-')) return 'colab-t4'
    const device = health?.hardware.preferredDevice?.toLowerCase()
    return device === 'cuda' || device === 'mps' || device === 'metal' ? 'local-gpu' : 'local-cpu'
  }

  const updateProjectJob = (jobId: string, patch: { state?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; progress?: number; output?: { assetId?: string; clipId?: string; trackId?: string }; error?: { message: string; retryable?: boolean } | null }) =>
    updateOperational((draft) => {
      const job = draft.jobs.find((entry) => entry.id === jobId)
      if (!job) return
      if (patch.state) job.state = patch.state
      if (patch.progress !== undefined) job.progress = patch.progress
      if (patch.output) job.output = { ...job.output, ...patch.output }
      if (patch.error === null) delete job.error
      else if (patch.error) job.error = patch.error
      job.updatedAt = new Date().toISOString()
    })

  const publishActiveJob = (presentation: JobPresentation) => {
    activeJobRef.current = presentation.job
    latestSessionRef.current = { ...latestSessionRef.current, activeJob: presentation }
    setActiveJob(presentation)
  }

  const clearPublishedActiveJob = (jobId: string) => {
    if (activeJobRef.current?.id === jobId) activeJobRef.current = null
    if (latestSessionRef.current.activeJob?.job.id === jobId) {
      latestSessionRef.current = { ...latestSessionRef.current, activeJob: null }
    }
    setActiveJob((current) => current?.job.id === jobId ? null : current)
  }

  const journalSubmittedJob = async (
    presentation: JobPresentation,
    appendProjectJob: (draft: Project) => void,
  ) => {
    await updateOperational(appendProjectJob)
    latestProjectRef.current = getCurrentProject()
    publishActiveJob(presentation)
    // Progress arrives every 350 ms while the ordinary save debounce is 450 ms.
    // This leading durability barrier prevents progress renders from starving
    // the only checkpoint that knows how to reconnect to the submitted job.
    await flushWorkspaceSave()
  }

  const recordTerminalJobError = async (jobId: string, error: unknown) => {
    if (error instanceof InferenceJobTerminalError && error.job.status === 'cancelled') {
      await updateProjectJob(jobId, { state: 'cancelled', progress: error.job.progress, error: null })
      return
    }
    await updateProjectJob(jobId, {
      state: 'failed',
      error: { message: error instanceof Error ? error.message : String(error), retryable: true },
    })
  }

  useEffect(() => {
    const controller = new AbortController()
    getInferenceHealth(controller.signal).then((nextHealth) => {
      setHealth(nextHealth)
      setGenerationProvider(nextHealth.generation.provider)
      setTranscriptionProvider(nextHealth.transcription.provider)
    }).catch(() => setHealth(null))
    return () => controller.abort()
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      persistence.loadWorkspace(initialProjectIdRef.current),
      loadPendingRecovery(initialProjectIdRef.current),
    ]).then(async ([storedSaved, storedRecovery]) => {
      let startupSaveError: unknown
      const saved = storedSaved ? await verifyCheckpointMedia(storedSaved) : undefined
      const recovery = storedRecovery
      if (cancelled) return
      if (saved) {
        replace(saved.project, true)
        setCandidates(saved.session.candidates)
        setActiveJob(saved.session.activeJob ?? null)
        if (!recovery && saved.session.activeJob) setResumeJobId(saved.session.activeJob.job.id)
        setSelectedClipId(null)
        setSelectedTrackId(null)
        rememberActiveProject(saved.project.id)
      } else {
        try {
          await persistence.saveWorkspace(startupProject, { candidates: [] })
        } catch (error) {
          startupSaveError = error
        }
      }
      if (recovery) {
        setRecoveryCheckpoint(recovery)
        recoveryCheckpointRef.current = recovery
        persistenceReadyRef.current = false
        setPersistenceLabel('Recovery checkpoint needs a decision')
      } else {
        persistenceReadyRef.current = true
        const backend = persistence.getBackend()
        setPersistenceLabel(persistenceLabelFor(backend))
        if (backend === 'memory') {
          void reportDurabilityIssue(startupSaveError ?? new ProjectDurabilityError('durable-storage-unavailable', ['memory']))
        } else {
          clearDurabilityIssue()
        }
      }
      setPersistenceReady(true)
    }).catch((error) => {
      persistenceReadyRef.current = true
      setPersistenceReady(true)
      setPersistenceLabel('Local journal unavailable')
      void reportDurabilityIssue(error)
    })
    return () => { cancelled = true }
  }, [clearDurabilityIssue, loadPendingRecovery, persistence, replace, reportDurabilityIssue, startupProject])

  useEffect(() => { rememberActiveProject(project.id) }, [project.id])

  useEffect(() => {
    if (!persistenceReady || !persistenceReadyRef.current || recoveryCheckpoint) return
    workspaceSaveCoordinator.schedule()
    return () => workspaceSaveCoordinator.cancelPending()
  }, [activeJob, candidates, persistenceReady, project, recoveryCheckpoint, workspaceSaveCoordinator])

  useEffect(() => {
    const flushBestEffort = () => {
      if (!persistenceReadyRef.current || recoveryCheckpointRef.current) return
      void flushWorkspaceSave().catch(() => undefined)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushBestEffort()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', flushBestEffort)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', flushBestEffort)
    }
  }, [flushWorkspaceSave])

  useEffect(() => {
    const engine = createPlaybackEngine(project, {
      onPosition: updatePlayhead,
      onStateChange: (state) => setPlaying(state === 'playing'),
      onEnded: () => setPlaying(false),
      onMeter: setMeters,
      onError: (error) => setToast(`Audio engine ${error.code}: ${error.message}`),
    })
    playbackRef.current = engine
    void engine.initialize().catch((error: unknown) => {
      setToast(`AudioWorklet unavailable: ${error instanceof Error ? error.message : String(error)}`)
    })
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        cancelCandidatePreview()
        return
      }
      if (!engine.needsReentry()) return
      void engine.reenter().catch((error: unknown) => {
        setToast(`Audio output could not resume: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      auditionPreviewGateRef.current.cancel()
      void engine.dispose()
      playbackRef.current = null
    }
  }, [cancelCandidatePreview])

  useEffect(() => { playbackRef.current?.setProject(project) }, [project])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 3_200)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!mutationError) return
    setToast(`${mutationError.label} blocked · ${mutationError.message}`)
    clearMutationError()
  }, [mutationError, clearMutationError])

  useEffect(() => {
    if (!exportOpen && !settingsOpen && !projectMenuOpen) return
    const closeDialog = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (projectDeleteTarget) {
        if (!projectDeleting) setProjectDeleteTarget(null)
        return
      }
      mixExportAbortRef.current?.abort()
      setExportOpen(false)
      setSettingsOpen(false)
      setProjectMenuOpen(false)
    }
    window.addEventListener('keydown', closeDialog)
    return () => window.removeEventListener('keydown', closeDialog)
  }, [exportOpen, projectDeleteTarget, projectDeleting, projectMenuOpen, settingsOpen])

  useEffect(() => () => {
    activeAbortRef.current?.abort()
    mixExportAbortRef.current?.abort()
    cancelCandidatePreview(false)
    playbackRef.current?.stopMidiNoteAudition()
  }, [cancelCandidatePreview])

  const recordAssetIntegrities = async (verified: Array<{ asset: AudioAsset; integrity: MediaIntegrity }>) => {
    if (!verified.some(({ asset, integrity }) => !sameIntegrity(asset.integrity, integrity))) return
    await updateOperational((draft) => {
      for (const { asset, integrity } of verified) {
        const stored = draft.assets.find((candidate) => candidate.id === asset.id)
        if (stored) stored.integrity = integrity
      }
    })
  }

  const clearDecodedPlaybackAssets = () => {
    const engine = playbackRef.current
    for (const assetId of decodedAssetHashesRef.current.keys()) engine?.unregisterAudioBuffer(assetId)
    decodedAssetHashesRef.current.clear()
  }

  const verifyProjectAudioAssets = async (targetProject: Project = project): Promise<Array<{ asset: AudioAsset; integrity: MediaIntegrity }>> => {
    const assetIds = allProjectAudioAssetIds(targetProject)
    const assets = [...assetIds].map((assetId) => {
      const asset = targetProject.assets.find((candidate) => candidate.id === assetId)
      if (!asset) {
        playbackRef.current?.unregisterAudioBuffer(assetId)
        decodedAssetHashesRef.current.delete(assetId)
        throw new Error(`Audio source ${assetId} is missing from the project`)
      }
      return asset
    })
    const verified = await Promise.all(assets.map(async (asset) => ({
      asset,
      integrity: await verifyMediaIntegrity(asset),
    })))
    if (targetProject.id === latestProjectRef.current.id) {
      await recordAssetIntegrities(verified)
    }
    for (const { asset, integrity } of verified) {
      if (integrity.state === 'missing' || integrity.state === 'corrupt') {
        playbackRef.current?.unregisterAudioBuffer(asset.id)
        decodedAssetHashesRef.current.delete(asset.id)
      }
      assertMediaUsable(asset.name, integrity)
    }
    return verified
  }

  const ensurePlaybackAssets = async (targetProject: Project) => {
    const engine = playbackRef.current
    if (!engine) return
    const verified = await verifyProjectAudioAssets(targetProject)
    await Promise.all(verified.map(async ({ asset, integrity }) => {
      const actualHash = integrity.actualHashSha256
      if (
        actualHash
        && decodedAssetHashesRef.current.get(asset.id) === actualHash
        && engine.hasAudioBuffer(asset.id)
      ) return
      try {
        await engine.decodeAndRegister(asset.id, asset.blob ?? asset.bytes!)
        if (actualHash) decodedAssetHashesRef.current.set(asset.id, actualHash)
      } catch (error) {
        engine.unregisterAudioBuffer(asset.id)
        decodedAssetHashesRef.current.delete(asset.id)
        throw new Error(`${asset.name}: encoded audio could not be decoded`, { cause: error })
      }
    }))
  }

  const togglePlayback = async () => {
    try {
      const engine = playbackRef.current
      if (!engine) return
      if (engine.getState() === 'playing') { engine.pause(); return }
      cancelCandidatePreview()
      const startBeat = playheadBeatRef.current
      let playbackProject: Project | undefined
      // A project switch, integrity checkpoint, or placement may commit while
      // PCM is decoding. Couple the exact render graph and asset set at the
      // playback boundary instead of relying on the passive setProject effect.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const targetProject = latestProjectRef.current
        engine.setProject(targetProject)
        await ensurePlaybackAssets(targetProject)
        if (latestProjectRef.current === targetProject) {
          playbackProject = targetProject
          break
        }
      }
      if (!playbackProject) {
        throw new Error('Project kept changing while audio was prepared; press Play again')
      }
      engine.setProject(playbackProject)
      await engine.play({ fromBeat: startBeat, loop: playbackProject.loop.enabled })
    } catch (error) {
      setToast(`Playback failed: ${(error as Error).message}`)
    }
  }

  const editClip = useCallback((trackId: string, clipId: string, edit: Partial<Clip>, mergeKey?: string) => {
    const track = project.tracks.find((item) => item.id === trackId)
    const current = track?.clips.find((item) => item.id === clipId)
    if (!track || !current) return
    const nextStart = edit.startBeat ?? current.startBeat
    const nextDuration = edit.durationBeats ?? current.durationBeats
    const collision = findClipCollision(track, clipId, nextStart, nextDuration)
    if (collision) {
      setToast(`Edit blocked · ${collision.name} already occupies that range`)
      return
    }
    void mutate('Move or trim region', (draft) => {
      const clip = draft.tracks.find((track) => track.id === trackId)?.clips.find((item) => item.id === clipId)
      if (clip) Object.assign(clip, edit)
    }, mergeKey)
  }, [mutate, project.tracks])

  const toggleTrack = useCallback((trackId: string, field: 'mute' | 'solo') => {
    const currentTrack = project.tracks.find((item) => item.id === trackId)
    if (!currentTrack) return
    const nextValue = !currentTrack[field]
    playbackRef.current?.setTrackParameters(trackId, { [field]: nextValue })
    void mutate(`${field === 'mute' ? 'Mute' : 'Solo'} track`, (draft) => {
      const track = draft.tracks.find((item) => item.id === trackId)
      if (track) track[field] = nextValue
    }).catch(() => {
      const committed = getCurrentProject().tracks.find((track) => track.id === trackId)
      if (committed) playbackRef.current?.setTrackParameters(trackId, { [field]: committed[field] })
    })
  }, [getCurrentProject, mutate, project.tracks])

  const setTrackGain = useCallback((trackId: string, gain: number) => {
    playbackRef.current?.setTrackParameters(trackId, { gain })
    void mutate('Adjust track gain', (draft) => {
      const track = draft.tracks.find((item) => item.id === trackId)
      if (track) track.gain = gain
    }, `track-gain:${trackId}`).catch(() => {
      const committed = getCurrentProject().tracks.find((track) => track.id === trackId)
      if (committed) playbackRef.current?.setTrackParameters(trackId, { gain: committed.gain })
    })
  }, [getCurrentProject, mutate])

  const setTrackPan = useCallback((trackId: string, pan: number) => {
    const normalizedPan = Math.max(-1, Math.min(1, pan))
    playbackRef.current?.setTrackParameters(trackId, { pan: normalizedPan })
    void mutate('Adjust track pan', (draft) => {
      const track = draft.tracks.find((item) => item.id === trackId)
      if (track) track.pan = normalizedPan
    }, `track-pan:${trackId}`).catch(() => {
      const committed = getCurrentProject().tracks.find((track) => track.id === trackId)
      if (committed) playbackRef.current?.setTrackParameters(trackId, { pan: committed.pan })
    })
  }, [getCurrentProject, mutate])

  const setMasterGain = useCallback((gain: number) => {
    const normalizedGain = Math.max(0, Math.min(1.25, gain))
    playbackRef.current?.setMasterGain(normalizedGain)
    void mutate('Adjust master gain', (draft) => {
      draft.masterGain = normalizedGain
    }, 'project:master-gain').catch(() => {
      playbackRef.current?.setMasterGain(getCurrentProject().masterGain)
    })
  }, [getCurrentProject, mutate])

  const changeProjectTempo = useCallback((requestedBpm: number): boolean => {
    const plan = planProjectTempoChange(project, requestedBpm)
    if (plan.collision) {
      setToast(`Tempo change blocked · ${plan.collision.clipName} would overlap ${plan.collision.conflictingClipName} on ${plan.collision.trackName}`)
      return false
    }
    void mutate('Change tempo', (draft) => applyProjectTempoChange(draft, plan)).catch((error) => {
      setToast(`Tempo change failed: ${(error as Error).message}`)
    })
    return true
  }, [mutate, project])

  const cancelTempoAnalysis = useCallback(() => {
    tempoAnalysisAbortRef.current?.abort()
    tempoAnalysisAbortRef.current = null
    setTempoAnalyzing(false)
  }, [])

  const analyzeSelectedAudioTempo = async () => {
    if (!selected || selected.clip.kind !== 'audio') return
    const asset = selectedAsset
    if (!asset) { setTempoAnalysisError('The selected region has no source asset'); return }
    cancelTempoAnalysis()
    const controller = new AbortController()
    tempoAnalysisAbortRef.current = controller
    setTempoAnalyzing(true)
    setTempoAnalysisError(null)
    const clipId = selected.clip.id
    const snapshot = captureMidiExtractionSnapshot(selected.clip, selected.track.id, project.bpm)
    let context: AudioContext | undefined
    try {
      const integrity = await verifyMediaIntegrity(asset)
      await recordAssetIntegrities([{ asset, integrity }])
      assertMediaUsable(asset.name, integrity)
      const media = asset.blob ?? (asset.bytes ? new Blob([asset.bytes], { type: asset.mimeType }) : undefined)
      if (!media) throw new Error('The selected audio has no local encoded bytes')
      context = new AudioContext()
      const buffer = await context.decodeAudioData(await media.arrayBuffer())
      const segment = extractMonoPcmClipSegment(
        Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel)),
        buffer.sampleRate,
        snapshot,
        snapshot.bpm,
      )
      const result = await analyzeTempoInWorker(
        segment.channelData,
        segment.sampleRate,
        { minimumBpm: 50, maximumBpm: 200 },
        { signal: controller.signal },
      )
      if (tempoAnalysisAbortRef.current !== controller) return
      setTempoAnalysis({ clipId, result })
      setToast(`Detected ${result.bpm.toFixed(1)} BPM · ${Math.round(result.confidence * 100)}% confidence`)
    } catch (error) {
      if ((error as Error).name !== 'AbortError' && tempoAnalysisAbortRef.current === controller) {
        const message = error instanceof Error ? error.message : 'Audio tempo analysis failed'
        setTempoAnalysisError(message)
        setToast(`Tempo detection failed: ${message}`)
      }
    } finally {
      await context?.close().catch(() => undefined)
      if (tempoAnalysisAbortRef.current === controller) {
        tempoAnalysisAbortRef.current = null
        setTempoAnalyzing(false)
      }
    }
  }

  const applyDetectedTempo = (bpm: number) => {
    if (!changeProjectTempo(bpm)) return
    setToast(`Project tempo set to detected ${bpm.toFixed(1)} BPM`)
  }

  useEffect(() => {
    cancelTempoAnalysis()
    setTempoAnalysis(null)
    setTempoAnalysisError(null)
  }, [cancelTempoAnalysis, selectedClipId])

  const selectClip = (clipId: string, trackId: string) => {
    setSelectedClipId(clipId)
    setSelectedTrackId(trackId)
  }

  const selectTrack = (trackId: string) => {
    setSelectedTrackId(trackId)
    setSelectedClipId(null)
    setSourceOpen(false)
    setInspectorOpen(true)
  }

  const openLinkedRegion = (clipId: string, trackId: string) => {
    const target = findClip(project, clipId)
    if (!target || target.track.id !== trackId || target.clip.kind !== 'audio') return
    setSelectedClipId(target.clip.id)
    setSelectedTrackId(target.track.id)
    setSourceOpen(false)
    setInspectorOpen(false)
    setMobileSurface('arrange')
    if (window.matchMedia?.('(max-width: 980px)').matches) {
      setDetailOpen(false)
      setDetailExpanded(false)
    }
    arrangementRevealSequenceRef.current += 1
    setArrangementRevealRequest({
      clipId: target.clip.id,
      requestId: arrangementRevealSequenceRef.current,
    })
  }

  const openClipDetail = useCallback((clipId: string, trackId: string) => {
    setSelectedClipId(clipId)
    setSelectedTrackId(trackId)
    setSourceOpen(false)
    setInspectorOpen(false)
    setDetailOpen(true)
    setMobileSurface('detail')
  }, [])

  const storeGeneratedCandidateInLibrary = useCallback(async (
    candidate: GeneratedCandidate,
    media: Blob | ArrayBuffer,
  ): Promise<string | null> => {
    try {
      await soundLibrary.put(generatedCandidateToSoundLibraryItem(candidate, media))
      await refreshSoundLibrary()
      return null
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The generated sound could not be saved globally'
      setLibraryError(message)
      return message
    }
  }, [refreshSoundLibrary, soundLibrary])

  const runGeneration = async () => {
    if (activeAbortRef.current) return
    if (!prompt.trim()) {
      setToast('Enter a prompt before generating')
      return
    }
    if (prompt.length > GENERATION_PROMPT_MAX_LENGTH) {
      setToast(`Generation prompt exceeds ${GENERATION_PROMPT_MAX_LENGTH} characters`)
      return
    }
    const controller = new AbortController()
    activeAbortRef.current = controller
    let submittedJobId: string | undefined
    try {
      const seed = generationSeed
      const submittedLength = resolveGenerationLength(generationLength, project.bpm, project.timeSignature)
      const job = await startGeneration({ prompt, duration: submittedLength.durationSeconds, bpm: project.bpm, seed, provider: generationProvider })
      submittedJobId = job.id
      const now = new Date().toISOString()
      await journalSubmittedJob(
        { label: 'Generating a local variation', job },
        (draft) => { draft.jobs.push({ id: job.id, kind: 'stable-audio-generation', state: job.status, computeTarget: jobComputeTarget(), progress: job.progress, createdAt: now, updatedAt: now, input: { prompt, durationSeconds: submittedLength.durationSeconds, seed, generationLength: submittedLength } }) },
      )
      const completed = await waitForJob<GeneratedAssetResult>(job.id, (next) => {
        publishActiveJob({ label: 'Generating a local variation', job: next as InferenceJob<unknown> })
      }, controller.signal)
      if (!completed.result) throw new Error('Generation finished without an audio asset')
      const result = completed.result
      const mediaResponse = await fetch(result.assetUrl)
      if (!mediaResponse.ok) throw new Error(`Generated audio request returned ${mediaResponse.status}`)
      const media = await mediaResponse.blob()
      const mediaIdentity = await establishMediaIdentity(media)
      const candidate: GeneratedCandidate = {
        id: makeId('candidate'),
        name: generatedClipName(prompt, submittedLength.durationSeconds),
        prompt,
        duration: result.duration,
        seed,
        generationLength: submittedLength,
        provider: result.provider,
        device: result.device,
        model: result.model ?? undefined,
        modelId: result.modelId ?? undefined,
        modelRevision: result.modelRevision ?? undefined,
        codeRevision: result.codeRevision ?? undefined,
        runtime: result.runtime ?? undefined,
        route: result.route ?? undefined,
        sourcePeak: result.sourcePeak,
        outputPeak: result.outputPeak,
        peakProtectionApplied: result.peakProtectionApplied,
        peakAttenuationDb: result.peakAttenuationDb,
        assetId: result.assetId,
        assetUrl: result.assetUrl,
        sampleRate: result.sampleRate,
        mimeType: media.type || 'audio/wav',
        peaks: normalizePeaks(result.peaks),
        jobId: completed.id,
        blob: media,
        ...mediaIdentity,
      }
      setCandidates((current) => [candidate, ...current])
      const libraryFailure = await storeGeneratedCandidateInLibrary(candidate, media)
      await updateProjectJob(completed.id, { state: 'completed', progress: 1, output: { assetId: result.assetId }, error: null })
      setToast(libraryFailure
        ? `${candidate.name} ready · global Library save failed: ${libraryFailure}`
        : `${candidate.name} ready · saved to the global Sound Library`)
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        if (submittedJobId) await recordTerminalJobError(submittedJobId, error)
        setToast((error as Error).message)
      }
    } finally {
      const ownsAbort = activeAbortRef.current === controller
      const ownsJob = ownsAbort && (submittedJobId
        ? activeJobRef.current?.id === submittedJobId
        : true)
      if (ownsAbort) activeAbortRef.current = null
      if (ownsJob && submittedJobId) clearPublishedActiveJob(submittedJobId)
      else if (ownsJob) {
        activeJobRef.current = null
        latestSessionRef.current = { ...latestSessionRef.current, activeJob: null }
        setActiveJob(null)
      }
    }
  }

  const cancelActiveJob = async () => {
    const originalController = activeAbortRef.current
    const job = activeJobRef.current
    if (!job) {
      originalController?.abort()
      if (activeAbortRef.current === originalController) activeAbortRef.current = null
      return
    }

    // Transfer ownership before aborting the poller. Its finally block must not
    // hide the job while the service is still deciding whether cancellation won.
    const handoffController = new AbortController()
    activeAbortRef.current = handoffController
    publishActiveJob({ label: 'Cancelling inference job…', job })
    originalController?.abort()

    try {
      await cancelJob(job.id)
    } catch (error) {
      if (activeAbortRef.current !== handoffController) return
      const message = error instanceof Error ? error.message : String(error)
      try {
        await updateProjectJob(job.id, {
          error: { message: `Cancellation was not confirmed: ${message}`, retryable: true },
        })
        latestProjectRef.current = getCurrentProject()
        publishActiveJob({ label: 'Cancellation unconfirmed · reconnecting', job })
        await flushWorkspaceSave()
      } catch (journalError) {
        publishActiveJob({ label: 'Cancellation unconfirmed · reconnecting', job })
        setToast(`Cancellation was not confirmed · local journal also failed: ${(journalError as Error).message}`)
        setResumeJobId(job.id)
        setResumeJobAttempt((attempt) => attempt + 1)
        return
      }
      setToast(`Cancellation was not confirmed · reconnecting: ${message}`)
      setResumeJobId(job.id)
      setResumeJobAttempt((attempt) => attempt + 1)
      return
    }

    if (activeAbortRef.current !== handoffController) return
    try {
      await updateProjectJob(job.id, { state: 'cancelled', progress: job.progress, error: null })
      latestProjectRef.current = getCurrentProject()
      activeAbortRef.current = null
      clearPublishedActiveJob(job.id)
      setResumeJobId((current) => current === job.id ? null : current)
      await flushWorkspaceSave()
      setToast('Inference job cancelled')
    } catch (error) {
      activeAbortRef.current = null
      clearPublishedActiveJob(job.id)
      setToast(`Job cancelled, but the local journal failed: ${(error as Error).message}`)
    }
  }

  const resolveCandidateMedia = async (candidate: GeneratedCandidate, signal?: AbortSignal): Promise<Blob> => {
    signal?.throwIfAborted()
    if (candidate.blob) return candidate.blob
    if (candidate.bytes) return new Blob([candidate.bytes], { type: candidate.mimeType || 'audio/wav' })
    if (!candidate.assetUrl) throw new Error('candidate media is not available')
    const response = await fetch(candidate.assetUrl, { signal })
    if (!response.ok) throw new Error(`asset request returned ${response.status}`)
    const blob = await response.blob()
    signal?.throwIfAborted()
    return blob
  }

  const resolveVerifiedCandidateMedia = async (candidate: GeneratedCandidate, signal?: AbortSignal): Promise<{
    blob: Blob
    integrity: MediaIntegrity
  }> => {
    const hadLocalMedia = Boolean(candidate.blob || candidate.bytes)
    const blob = await resolveCandidateMedia(candidate, signal)
    const integrity = await verifyMediaIntegrity(hadLocalMedia
      ? candidate
      : { blob, contentHashSha256: candidate.contentHashSha256 })
    signal?.throwIfAborted()
    setCandidates((current) => current.map((entry) => entry.id === candidate.id
      ? {
          ...entry,
          ...(!hadLocalMedia ? { blob, mimeType: blob.type || entry.mimeType } : {}),
          integrity,
        }
      : entry))
    assertMediaUsable(candidate.name, integrity)
    return { blob, integrity }
  }

  const previewCandidate = async (candidate: GeneratedCandidate) => {
    const engine = playbackRef.current
    if ((!candidate.assetUrl && !candidate.blob && !candidate.bytes) || !engine) { setToast('Audition is unavailable because this candidate has no encoded audio.'); return }
    const gate = auditionPreviewGateRef.current
    if (gate.activeCandidateId === candidate.id) {
      cancelCandidatePreview()
      return
    }
    const request = gate.begin(candidate.id)
    engine.stopAudition()
    setPreviewCandidateId(candidate.id)
    try {
      const { blob } = await resolveVerifiedCandidateMedia(candidate, request.signal)
      if (!gate.isCurrent(request) || playbackRef.current !== engine) return
      await engine.audition(candidate.assetId ?? candidate.id, blob, () => {
        if (gate.finish(request)) setPreviewCandidateId(null)
      })
      if (!gate.isCurrent(request) || playbackRef.current !== engine) engine.stopAudition()
    } catch (error) {
      const current = gate.finish(request)
      if (current) setPreviewCandidateId(null)
      if (!current || isAbortError(error)) return
      setToast(`Audition failed: ${(error as Error).message}`)
    }
  }

  const placeCandidate = async (
    candidate: GeneratedCandidate,
    placement?: { trackId: string; startBeat: number },
  ) => {
    let blob: Blob | undefined
    let integrity: MediaIntegrity | undefined
    if (auditionPreviewGateRef.current.activeCandidateId === candidate.id) cancelCandidatePreview()
    try {
      ({ blob, integrity } = await resolveVerifiedCandidateMedia(candidate))
      const existingAsset = project.assets.find((asset) => asset.id === candidate.assetId)
      if (existingAsset) {
        const existingIntegrity = await verifyMediaIntegrity(existingAsset)
        await recordAssetIntegrities([{ asset: existingAsset, integrity: existingIntegrity }])
        assertMediaUsable(existingAsset.name, existingIntegrity)
        if (existingIntegrity.actualHashSha256 !== integrity.actualHashSha256) {
          throw new Error('The candidate asset ID already belongs to different source media')
        }
      }
    }
    catch (error) { setToast(`Could not place generated audio: ${(error as Error).message}`); return }
    const assetId = candidate.assetId ?? makeId('asset')
    const clipId = makeId('clip-audio')
    const requestedStartBeat = placement?.startBeat ?? (project.loop.enabled ? project.loop.startBeat : playheadBeat)
    const startBeat = snapDivision !== null ? snapBeat(requestedStartBeat, snapDivision) : requestedStartBeat
    const generatedAsBars = candidate.generationLength?.unit === 'bars'
    const clipDurationBeats = generatedAsBars && candidate.generationLength
      ? candidate.generationLength.value * beatsPerBar(candidate.generationLength.timeSignature)
      : secondsToBeats(candidate.duration, project.bpm)
    const clipTimebase: AudioClip['timebase'] = generatedAsBars && candidate.generationLength
      ? { mode: 'tempo-follow-repitch', sourceBpm: candidate.generationLength.bpm }
      : { mode: 'fixed-seconds', sourceBpm: project.bpm }
    const requestedTrack = placement
      ? project.tracks.find((track) => track.id === placement.trackId)
      : selectedTrack
    if (placement && !requestedTrack) {
      setToast('Place blocked · the target track no longer exists')
      return
    }
    if (requestedTrack?.kind === 'midi') {
      setToast(`Place blocked · ${requestedTrack.name} is a MIDI track; select an Audio track`)
      return
    }
    const requestedTrackOccupied = requestedTrack ? findClipCollision(requestedTrack, clipId, startBeat, clipDurationBeats) : null
    if (requestedTrack && requestedTrackOccupied) {
      setToast(`Place blocked · ${requestedTrackOccupied.name} already occupies that range on ${requestedTrack.name}`)
      return
    }
    const trackId = requestedTrack?.id ?? makeId('track-audio')
    const liveEngine = playbackRef.current
    const liveHash = integrity?.actualHashSha256
    if (
      blob
      && liveEngine?.getState() === 'playing'
      && (!liveEngine.hasAudioBuffer(assetId) || !liveHash || decodedAssetHashesRef.current.get(assetId) !== liveHash)
    ) {
      try {
        await liveEngine.decodeAndRegister(assetId, blob)
        if (liveHash) decodedAssetHashesRef.current.set(assetId, liveHash)
      } catch (error) {
        liveEngine.unregisterAudioBuffer(assetId)
        decodedAssetHashesRef.current.delete(assetId)
        setToast(`Could not place generated audio into live playback: ${(error as Error).message}`)
        return
      }
    }
    try {
      await mutate('Place generated audio', (draft) => {
        if (!draft.assets.some((asset) => asset.id === assetId)) {
          draft.assets.push({
            id: assetId,
            name: candidate.name,
            mimeType: blob?.type || 'audio/wav',
            durationSeconds: candidate.duration,
            sampleRate: candidate.sampleRate,
            channelCount: 2,
            createdAt: new Date().toISOString(),
            blob,
            contentHashSha256: candidate.contentHashSha256,
            waveform: candidate.peaks ? [candidate.peaks] : undefined,
            integrity,
            provenance: { source: generationSource(candidate.provider), createdAt: new Date().toISOString(), model: candidate.modelId ?? candidate.model ?? candidate.provider, prompt: candidate.prompt, jobId: candidate.jobId, metadata: { seed: candidate.seed ?? null, modelRevision: candidate.modelRevision ?? null, codeRevision: candidate.codeRevision ?? null, runtime: candidate.runtime ?? null, route: candidate.route ?? null, sourcePeak: candidate.sourcePeak ?? null, outputPeak: candidate.outputPeak ?? null, peakProtectionApplied: candidate.peakProtectionApplied ?? false, peakAttenuationDb: candidate.peakAttenuationDb ?? 0, generationLengthUnit: candidate.generationLength?.unit ?? null, generationLengthValue: candidate.generationLength?.value ?? null, generationLengthSeconds: candidate.generationLength?.durationSeconds ?? candidate.duration, generationLengthBpm: candidate.generationLength?.bpm ?? null, generationLengthMeter: candidate.generationLength ? `${candidate.generationLength.timeSignature.numerator}/${candidate.generationLength.timeSignature.denominator}` : null } },
          })
        }
        let track = draft.tracks.find((entry) => entry.id === trackId)
        if (!track) {
          track = { id: trackId, name: 'Generated audio', kind: 'audio', color: '#F6A84B', gain: 0.9, pan: 0, mute: false, solo: false, clips: [] }
          draft.tracks.unshift(track)
        }
        if (track.clips.length === 0) track.name = candidate.name
        const clip: AudioClip = {
          id: clipId,
          name: candidate.name,
          kind: 'audio',
          startBeat,
          durationBeats: clipDurationBeats,
          offsetBeats: 0,
          assetId,
          timebase: clipTimebase,
          gain: 1,
          fadeIn: 0.02,
          fadeOut: 0.04,
          provenance: { source: generationSource(candidate.provider), createdAt: new Date().toISOString(), model: candidate.modelId ?? candidate.model ?? candidate.provider, prompt: candidate.prompt, jobId: candidate.jobId, metadata: { seed: candidate.seed ?? null, modelRevision: candidate.modelRevision ?? null, codeRevision: candidate.codeRevision ?? null, runtime: candidate.runtime ?? null, route: candidate.route ?? null, sourcePeak: candidate.sourcePeak ?? null, outputPeak: candidate.outputPeak ?? null, peakProtectionApplied: candidate.peakProtectionApplied ?? false, peakAttenuationDb: candidate.peakAttenuationDb ?? 0, generationLengthUnit: candidate.generationLength?.unit ?? null, generationLengthValue: candidate.generationLength?.value ?? null, generationLengthSeconds: candidate.generationLength?.durationSeconds ?? candidate.duration, generationLengthBpm: candidate.generationLength?.bpm ?? null, generationLengthMeter: candidate.generationLength ? `${candidate.generationLength.timeSignature.numerator}/${candidate.generationLength.timeSignature.denominator}` : null } },
        }
        track.clips.push(clip)
      })
    } catch {
      if (!project.assets.some((asset) => asset.id === assetId)) {
        liveEngine?.unregisterAudioBuffer(assetId)
        decodedAssetHashesRef.current.delete(assetId)
      }
      return
    }
    const placedProject = getCurrentProject()
    latestProjectRef.current = placedProject
    if (liveEngine && playbackRef.current === liveEngine && liveEngine.getState() === 'playing') {
      liveEngine.setProject(placedProject)
    }
    if (candidate.jobId) updateProjectJob(candidate.jobId, { output: { assetId, clipId, trackId } })
    selectClip(clipId, trackId)
    setMobileSurface('arrange')
    setToast(requestedTrack ? `Audio placed on ${requestedTrack.name} · source remains immutable` : 'Audio placed on a new Audio track · source remains immutable')
  }

  const downloadCandidate = async (candidate: GeneratedCandidate) => {
    try {
      const { blob } = await resolveVerifiedCandidateMedia(candidate)
      downloadBlob(blob, `${candidate.name.replace(/\s+/g, '-')}.wav`)
    } catch (error) {
      setToast(`Could not download candidate: ${(error as Error).message}`)
    }
  }

  const previewLibrarySound = (item: SoundLibraryItem) =>
    previewCandidate(soundLibraryItemToCandidate(item))

  const placeLibrarySound = (item: SoundLibraryItem) =>
    placeCandidate(soundLibraryItemToCandidate(item))

  const dropAudioSource = (payload: AudioSourceDragPayload, trackId: string, startBeat: number) => {
    const libraryItem = payload.source === 'library'
      ? libraryItems.find((entry) => entry.id === payload.id)
      : undefined
    const candidate = payload.source === 'candidate'
      ? candidates.find((entry) => entry.id === payload.id)
      : libraryItem ? soundLibraryItemToCandidate(libraryItem) : undefined
    if (!candidate) {
      setToast('Place blocked · the dragged sound is no longer available')
      return
    }
    void placeCandidate(candidate, { trackId, startBeat })
  }

  const downloadLibrarySound = (item: SoundLibraryItem) =>
    downloadCandidate(soundLibraryItemToCandidate(item))

  const deleteLibrarySound = async (item: SoundLibraryItem) => {
    if (!window.confirm(`Delete “${item.name}” from the global Sound Library? Existing project clips remain intact.`)) return
    try {
      if (auditionPreviewGateRef.current.activeCandidateId === soundLibraryCandidateId(item.id)) cancelCandidatePreview()
      await soundLibrary.remove(item.id)
      await refreshSoundLibrary()
      setToast('Sound removed from the global Library · existing project clips were not changed')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The sound could not be deleted'
      setLibraryError(message)
      setToast(`Library delete failed: ${message}`)
    }
  }

  const extractMidi = async () => {
    if (activeAbortRef.current) return
    if (!selected || selected.clip.kind !== 'audio') return
    const asset = selectedAsset
    if (!asset) { setToast('MIDI extraction blocked: source asset metadata is missing.'); return }
    try {
      const integrity = await verifyMediaIntegrity(asset)
      await recordAssetIntegrities([{ asset, integrity }])
      assertMediaUsable(asset.name, integrity)
    } catch (error) {
      setToast(`MIDI extraction blocked: ${(error as Error).message}`)
      return
    }
    const blob = asset?.blob ?? (asset?.bytes ? new Blob([asset.bytes], { type: asset.mimeType }) : undefined)
    if (!blob) { setToast('Generate or import encoded audio before extraction.'); return }
    const controller = new AbortController()
    activeAbortRef.current = controller
    let submittedJobId: string | undefined
    const submission = captureMidiExtractionSnapshot(selected.clip, selected.track.id, project.bpm)
    try {
      const context = new AudioContext()
      let selectedAudio: Blob
      try {
        const buffer = await context.decodeAudioData(await blob.arrayBuffer())
        const segment = extractMonoPcmClipSegment(
          Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel)),
          buffer.sampleRate,
          submission,
          submission.bpm,
        )
        selectedAudio = new Blob([encodeWav(segment.channelData, segment.sampleRate, { bitDepth: 16 })], { type: 'audio/wav' })
      } finally {
        await context.close().catch(() => undefined)
      }
      const job = await startTranscription(selectedAudio, `${submission.sourceClipName}.wav`, transcriptionProvider)
      submittedJobId = job.id
      const now = new Date().toISOString()
      await journalSubmittedJob(
        { label: 'Extracting MIDI structure', job },
        (draft) => { draft.jobs.push({ id: job.id, kind: 'midi-extraction', state: job.status, computeTarget: jobComputeTarget(), progress: job.progress, createdAt: now, updatedAt: now, input: { assetId: submission.sourceAssetId, trackId: submission.sourceTrackId, clipId: submission.sourceClipId, durationSeconds: beatsToSeconds(submission.durationBeats, submission.bpm), midiExtraction: submission } }) },
      )
      const completed = await waitForJob<TranscriptionResult>(job.id, (next) => {
        publishActiveJob({ label: 'Extracting MIDI structure', job: next as InferenceJob<unknown> })
      }, controller.signal)
      if (!completed.result) throw new Error('Extraction finished without MIDI data')
      const result = completed.result
      const trackId = makeId('track-midi')
      const clipId = makeId('clip-midi')
      let created = false
      let committedNoteCount = 0
      await mutate('Extract MIDI to linked track', (draft) => {
        const midiClip = createExtractedMidiClip({
          clipId,
          jobId: completed.id,
          createdAt: new Date().toISOString(),
          snapshot: submission,
          result,
        })
        committedNoteCount = midiClip.notes.length
        const sourceIndex = draft.tracks.findIndex((track) => track.id === submission.sourceTrackId)
        const track: Track = { id: trackId, name: 'Extracted MIDI', kind: 'midi', midi: createMidiTrackSettingsForTranscription(result.notes), color: '#5DD6D1', gain: 0.75, pan: 0, mute: false, solo: false, clips: [midiClip] }
        draft.tracks.splice(sourceIndex < 0 ? draft.tracks.length : sourceIndex + 1, 0, track)
        created = true
      })
      if (!created) { await updateProjectJob(completed.id, { state: 'completed', progress: 1, output: { assetId: result.midiAssetId }, error: null }); setToast('MIDI result kept on the inference service because local placement failed.'); return }
      await updateProjectJob(completed.id, { state: 'completed', progress: 1, output: { assetId: result.midiAssetId, clipId, trackId }, error: null })
      selectClip(clipId, trackId)
      setToast(`MIDI extracted · ${extractionNoteSummary(result.notes.length, committedNoteCount)}`)
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        if (submittedJobId) await recordTerminalJobError(submittedJobId, error)
        setToast((error as Error).message)
      }
    } finally {
      const ownsAbort = activeAbortRef.current === controller
      const ownsJob = ownsAbort && (submittedJobId
        ? activeJobRef.current?.id === submittedJobId
        : true)
      if (ownsAbort) activeAbortRef.current = null
      if (ownsJob && submittedJobId) clearPublishedActiveJob(submittedJobId)
      else if (ownsJob) {
        activeJobRef.current = null
        latestSessionRef.current = { ...latestSessionRef.current, activeJob: null }
        setActiveJob(null)
      }
    }
  }

  const deleteSelected = async () => {
    if (!selected) return
    const clipId = selected.clip.id
    await mutate('Delete region', (draft) => { for (const track of draft.tracks) track.clips = track.clips.filter((clip) => clip.id !== clipId) })
    setSelectedClipId(null)
  }

  const duplicateSelected = async () => {
    if (!selected) return
    const nextId = makeId('clip')
    const nextStart = findNextAvailableClipStart(
      selected.track,
      nextId,
      selected.clip.startBeat + selected.clip.durationBeats,
      selected.clip.durationBeats,
    )
    await mutate('Duplicate region', (draft) => {
      const track = draft.tracks.find((item) => item.id === selected.track.id)
      if (!track) return
      const copy = structuredClone(selected.clip)
      copy.id = nextId
      copy.name = `${copy.name} copy`
      copy.startBeat = nextStart
      track.clips.push(copy)
    })
    selectClip(nextId, selected.track.id)
  }

  const commitSplit = async (target: PendingMidiSplit, policy: MidiCrossingNotePolicy) => {
    const rightId = makeId('clip')
    try {
      await mutate('Split region', (draft) => {
        const track = draft.tracks.find((item) => item.id === target.trackId)
        const clipIndex = track?.clips.findIndex((item) => item.id === target.clipId) ?? -1
        const clip = clipIndex >= 0 ? track?.clips[clipIndex] : undefined
        if (!track || !clip) return
        const result = splitClipAtBeat(clip, target.atBeat, {
          createId: (kind) => kind === 'clip' ? rightId : makeId('note'),
          ...(clip.kind === 'midi' ? { crossingNotePolicy: policy } : {}),
        })
        const baseName = clip.name.replace(/\s+[AB]$/, '')
        result.left.name = `${baseName} A`
        result.right.name = `${baseName} B`
        track.clips.splice(clipIndex, 1, result.left, result.right)
      })
      selectClip(rightId, target.trackId)
    } catch (error) {
      setToast(`Split blocked · ${(error as Error).message}`)
    }
  }

  const splitSelected = async () => {
    if (!selected || playheadBeat <= selected.clip.startBeat || playheadBeat >= selected.clip.startBeat + selected.clip.durationBeats) return
    const target: PendingMidiSplit = {
      clipId: selected.clip.id,
      trackId: selected.track.id,
      atBeat: playheadBeat,
      affectedNotes: selected.clip.kind === 'midi'
        ? getArrangedMidiNotes(selected.clip).filter((instance) => instance.startBeat < playheadBeat && instance.startBeat + instance.durationBeats > playheadBeat).length
        : 0,
      onlyKeep: selected.clip.kind === 'midi' && Boolean(selected.clip.sourceLoop),
    }
    if (selected.clip.kind === 'midi' && target.affectedNotes > 0) {
      setPendingMidiSplit(target)
      return
    }
    await commitSplit(target, 'keep')
  }

  const editSelectedProperty = (patch: Partial<Clip>, parameter: string) => {
    if (selected) editClip(selected.track.id, selected.clip.id, patch, `clip:${selected.clip.id}:${parameter}`)
  }

  const auditionMidiNote = useCallback((pitch: number, phase: 'start' | 'stop', track: MidiTrack) => {
    const engine = playbackRef.current
    if (!engine) return
    if (phase === 'stop') {
      engine.stopMidiNoteAudition()
      return
    }
    void engine.auditionMidiNote(track.id, pitch).catch((error: unknown) => {
      setToast(`MIDI audition failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, [])

  const toggleSelectedClipMute = () => {
    if (!selected) return
    const trackId = selected.track.id
    const clipId = selected.clip.id
    const muting = !selected.clip.muted
    void mutate(`${muting ? 'Mute' : 'Unmute'} region`, (draft) => {
      const clip = draft.tracks.find((track) => track.id === trackId)?.clips.find((item) => item.id === clipId)
      if (clip) clip.muted = !clip.muted
    })
  }

  const toggleSelectedSourceLoop = () => {
    if (!selected) return
    const trackId = selected.track.id
    const clipId = selected.clip.id
    const enabling = !selected.clip.sourceLoop
    const cycleLengthBeats = selected.clip.durationBeats
    const nextOccupiedStart = selected.track.clips
      .filter((clip) => clip.id !== clipId && clip.startBeat >= selected.clip.startBeat + selected.clip.durationBeats - 1e-9)
      .reduce((minimum, clip) => Math.min(minimum, clip.startBeat), Number.POSITIVE_INFINITY)
    const desiredDuration = cycleLengthBeats * 2
    const enabledDuration = Math.max(cycleLengthBeats, Math.min(desiredDuration, nextOccupiedStart - selected.clip.startBeat))
    void mutate(`${enabling ? 'Enable' : 'Disable'} clip loop`, (draft) => {
      const clip = draft.tracks.find((track) => track.id === trackId)?.clips.find((item) => item.id === clipId)
      if (!clip) return
      if (clip.sourceLoop) {
        // Disabling source looping must preserve the arrangement placement. Rebase
        // the clip onto the currently audible source phase instead of changing its
        // duration, which could unexpectedly reveal or collide with other regions.
        clip.offsetBeats = clip.sourceLoop.cycleStartBeat + clip.sourceLoop.phaseBeats
        delete clip.sourceLoop
        return
      }
      clip.sourceLoop = {
        cycleStartBeat: clip.offsetBeats,
        cycleLengthBeats,
        phaseBeats: 0,
      }
      clip.durationBeats = enabledDuration
    })
    if (enabling && enabledDuration <= cycleLengthBeats + 1e-9) setToast('Clip loop enabled · drag its upper edge when a free range is available')
  }

  const editNote = (noteId: string, patch: Partial<MidiNote>) => {
    if (!selected || selected.clip.kind !== 'midi') return
    void mutate('Edit MIDI note', (draft) => {
      const clip = draft.tracks.flatMap((track) => track.clips).find((item) => item.id === selected.clip.id)
      if (clip?.kind !== 'midi') return
      const note = clip.notes.find((item) => item.id === noteId)
      if (note) Object.assign(note, patch)
    }, `note:${noteId}`)
  }

  const editNotes = (candidateEdits: readonly MidiNoteBatchEdit[]) => {
    if (!selected || selected.clip.kind !== 'midi') return
    const clipId = selected.clip.id
    const edits = normalizeMidiNoteBatch(selected.clip.notes, candidateEdits)
    if (edits.length === 0) return
    const fields = [...new Set(edits.flatMap((edit) => Object.keys(edit.patch)))].sort().join('+')
    const mergeKey = `notes:${clipId}:${edits.map((edit) => edit.id).sort().join(',')}:${fields}`
    void mutate('Edit MIDI notes', (draft) => {
      const clip = draft.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId)
      if (clip?.kind !== 'midi') return
      const notesById = new Map(clip.notes.map((note) => [note.id, note]))
      edits.forEach(({ id, patch }) => {
        const note = notesById.get(id)
        if (note) Object.assign(note, patch)
      })
    }, mergeKey)
  }

  const addNote = (note: Omit<MidiNote, 'id'>) => {
    if (!selected || selected.clip.kind !== 'midi') return
    void mutate('Add MIDI note', (draft) => {
      const clip = draft.tracks.flatMap((track) => track.clips).find((item) => item.id === selected.clip.id)
      if (clip?.kind === 'midi') clip.notes.push({ ...note, id: makeId('note') })
    })
  }

  const deleteNote = (noteId: string) => {
    if (!selected || selected.clip.kind !== 'midi') return
    void mutate('Delete MIDI note', (draft) => {
      const clip = draft.tracks.flatMap((track) => track.clips).find((item) => item.id === selected.clip.id)
      if (clip?.kind === 'midi') clip.notes = clip.notes.filter((note) => note.id !== noteId)
    })
  }

  const deleteNotes = (candidateIds: readonly string[]) => {
    if (!selected || selected.clip.kind !== 'midi') return
    const clipId = selected.clip.id
    const noteIds = existingMidiNoteIds(selected.clip.notes, candidateIds)
    if (noteIds.length === 0) return
    const deleting = new Set(noteIds)
    void mutate('Delete MIDI notes', (draft) => {
      const clip = draft.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId)
      if (clip?.kind === 'midi') clip.notes = clip.notes.filter((note) => !deleting.has(note.id))
    })
  }

  const quantizeSelected = (division: NoteDivision, strength: number, candidateIds: readonly string[]) => {
    if (!selected || selected.clip.kind !== 'midi') return
    const clipId = selected.clip.id
    const noteIds = existingMidiNoteIds(selected.clip.notes, candidateIds)
    if (noteIds.length === 0) return
    const selectedIds = new Set(noteIds)
    const window = selected.clip.sourceLoop
      ? {
          startBeat: selected.clip.sourceLoop.cycleStartBeat,
          endBeat: selected.clip.sourceLoop.cycleStartBeat + selected.clip.sourceLoop.cycleLengthBeats,
        }
      : {
          startBeat: selected.clip.offsetBeats,
          endBeat: selected.clip.offsetBeats + selected.clip.durationBeats,
        }
    const quantized = new Map<string, number>()
    selected.clip.notes.forEach((note) => {
      if (!selectedIds.has(note.id)) return
      const minimum = Math.max(0, window.startBeat - note.durationBeats + 1 / 16)
      const maximum = Math.max(minimum, window.endBeat - 1 / 16)
      const requested = snapBeat(note.startBeat, { division, strength })
      const next = Math.min(maximum, Math.max(minimum, requested))
      if (Math.abs(next - note.startBeat) > 1e-9) quantized.set(note.id, next)
    })
    if (quantized.size === 0) return
    void mutate(`Quantize ${quantized.size} MIDI ${quantized.size === 1 ? 'note' : 'notes'}`, (draft) => {
      const clip = draft.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId)
      if (clip?.kind !== 'midi') return
      clip.notes.forEach((note) => {
        const startBeat = quantized.get(note.id)
        if (startBeat !== undefined) note.startBeat = startBeat
      })
    })
  }

  const addTrack = (kind: TrackKind) => {
    const trackId = makeId(`track-${kind}`)
    const prefix = kind === 'audio' ? 'New audio' : 'New MIDI'
    const usedNames = new Set(project.tracks.map((track) => track.name))
    let name = prefix
    let ordinal = 2
    while (usedNames.has(name)) {
      name = `${prefix} ${ordinal}`
      ordinal += 1
    }
    void mutate(`Add ${kind} track`, (draft) => {
      if (kind === 'audio') {
        draft.tracks.push({ id: trackId, name, kind: 'audio', color: '#F6A84B', gain: 0.82, pan: 0, mute: false, solo: false, clips: [] })
      } else {
        draft.tracks.push({ id: trackId, name, kind: 'midi', midi: createMelodicMidiTrackSettings(), color: '#5DD6D1', gain: 0.78, pan: 0, mute: false, solo: false, clips: [] })
      }
    }).then(() => {
      selectTrack(trackId)
      setToast(`${kind === 'audio' ? 'Audio' : 'MIDI'} track added`)
    }).catch(() => undefined)
  }

  const renameTrack = (trackId: string, name: string) => {
    const trimmed = name.trim()
    const current = project.tracks.find((track) => track.id === trackId)
    if (!current || !trimmed || trimmed === current.name) return
    void mutate('Rename track', (draft) => {
      const track = draft.tracks.find((candidate) => candidate.id === trackId)
      if (track) track.name = trimmed
    })
  }

  const renameRegion = (clipId: string, name: string) => {
    const trimmed = name.trim()
    const current = findClip(project, clipId)?.clip
    if (!current || !trimmed || trimmed === current.name) return
    void mutate('Rename region', (draft) => {
      const clip = findClip(draft, clipId)?.clip
      if (clip) clip.name = trimmed
    })
  }

  const deleteTrack = (trackId: string) => {
    const track = project.tracks.find((candidate) => candidate.id === trackId)
    if (!track) return
    const deletingSelection = selectedTrackId === trackId || selected?.track.id === trackId
    void mutate('Delete track', (draft) => {
      draft.tracks = draft.tracks.filter((candidate) => candidate.id !== trackId)
    }).then(() => {
      if (deletingSelection) {
        setSelectedClipId(null)
        setSelectedTrackId(null)
        setDetailOpen(false)
        setDetailExpanded(false)
        setInspectorOpen(false)
        if (mobileSurface === 'detail') setMobileSurface('arrange')
      }
      setToast(`${track.name} deleted · Undo restores the complete track`)
    }).catch(() => undefined)
  }

  const setMidiTrackSettings = (trackId: string, settings: MidiTrackSettings) => {
    void mutate('Change MIDI routing', (draft) => {
      const track = draft.tracks.find((candidate) => candidate.id === trackId)
      if (track?.kind === 'midi') track.midi = structuredClone(settings)
    })
  }

  const moveTrack = (trackId: string, direction: 'up' | 'down') => {
    const currentIndex = project.tracks.findIndex((track) => track.id === trackId)
    const nextIndex = currentIndex + (direction === 'up' ? -1 : 1)
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= project.tracks.length) return
    void mutate('Move track', (draft) => {
      draft.tracks = moveTrackInOrder(draft.tracks, trackId, direction)
    })
  }

  const moveClip = useCallback((sourceTrackId: string, targetTrackId: string, clipId: string, startBeat: number) => {
    const sourceTrack = project.tracks.find((track) => track.id === sourceTrackId)
    const targetTrack = project.tracks.find((track) => track.id === targetTrackId)
    const sourceClip = sourceTrack?.clips.find((clip) => clip.id === clipId)
    if (!sourceTrack || !targetTrack || !sourceClip || targetTrack.kind !== sourceClip.kind) return
    const nextStartBeat = Math.max(0, startBeat)
    if (sourceTrackId === targetTrackId && Math.abs(sourceClip.startBeat - nextStartBeat) < 0.000_001) return
    const collision = findClipCollision(targetTrack, clipId, nextStartBeat, sourceClip.durationBeats)
    if (collision) {
      setToast(`Move blocked · ${collision.name} already occupies that range`)
      return
    }

    void mutate('Move region', (draft) => {
      const draftSource = draft.tracks.find((track) => track.id === sourceTrackId)
      const draftTarget = draft.tracks.find((track) => track.id === targetTrackId)
      const clipIndex = draftSource?.clips.findIndex((clip) => clip.id === clipId) ?? -1
      const clip = clipIndex >= 0 ? draftSource?.clips[clipIndex] : undefined
      if (!draftSource || !draftTarget || !clip || draftTarget.kind !== clip.kind) return
      clip.startBeat = nextStartBeat
      if (draftSource.id !== draftTarget.id) {
        draftSource.clips.splice(clipIndex, 1)
        draftTarget.clips.push(clip)
      }
    })
    setSelectedClipId(clipId)
    setSelectedTrackId(targetTrackId)
  }, [mutate, project.tracks])

  const importAudio = async (file?: File) => {
    if (!file) { importInputRef.current?.click(); return }
    const context = new AudioContext()
    try {
      const mediaIdentity = await establishMediaIdentity(file)
      const buffer = await context.decodeAudioData(await file.arrayBuffer())
      const peaks = extractWaveformPeaks(buffer, 512)
      const assetId = makeId('asset-import')
      const trackId = makeId('track-import')
      const clipId = makeId('clip-import')
      await mutate('Import audio', (draft) => {
        const asset: AudioAsset = { id: assetId, name: file.name, mimeType: file.type || 'audio/wav', durationSeconds: buffer.duration, sampleRate: buffer.sampleRate, channelCount: buffer.numberOfChannels, createdAt: new Date().toISOString(), blob: file, waveform: [peaks], ...mediaIdentity, provenance: { source: 'import', createdAt: new Date().toISOString() } }
        draft.assets.push(asset)
        draft.tracks.push({ id: trackId, name: file.name.replace(/\.[^.]+$/, ''), kind: 'audio', color: '#F6A84B', gain: 0.9, pan: 0, mute: false, solo: false, clips: [{ id: clipId, name: file.name, kind: 'audio', startBeat: playheadBeat, durationBeats: secondsToBeats(buffer.duration, draft.bpm), offsetBeats: 0, assetId, timebase: { mode: 'fixed-seconds', sourceBpm: draft.bpm }, gain: 1, fadeIn: 0.02, fadeOut: 0.04, provenance: { source: 'import', createdAt: new Date().toISOString() } }] })
      })
      selectClip(clipId, trackId)
      setToast('Audio imported into the local project')
    } catch (error) { setToast(`Import failed: ${(error as Error).message}`) }
    finally { await context.close().catch(() => undefined) }
  }

  const commitCheckpointToUi = (checkpoint: ProjectCheckpoint) => {
    // During development, keep a Fast Refresh re-run of the bootstrap effect
    // pinned to the project the user opened rather than the first mount.
    initialProjectIdRef.current = checkpoint.project.id
    latestProjectRef.current = checkpoint.project
    latestSessionRef.current = checkpoint.session
    activeAbortRef.current?.abort()
    activeAbortRef.current = null
    cancelCandidatePreview()
    playbackRef.current?.stop(0)
    clearDecodedPlaybackAssets()
    replace(checkpoint.project, true)
    rememberActiveProject(checkpoint.project.id)
    setCandidates(checkpoint.session.candidates)
    setActiveJob(checkpoint.session.activeJob ?? null)
    activeJobRef.current = checkpoint.session.activeJob?.job ?? null
    setResumeJobId(checkpoint.session.activeJob?.job.id ?? null)
    setSelectedClipId(null)
    setSelectedTrackId(null)
    updatePlayhead(0)
  }

  const exportProjectBundle = async () => {
    let emergencySnapshot = false
    try {
      setToast('Saving and verifying the portable project…')
      let checkpoint: ProjectCheckpoint
      try {
        checkpoint = await flushWorkspaceSave()
      } catch (error) {
        emergencySnapshot = true
        void reportDurabilityIssue(error)
        checkpoint = createProjectCheckpoint(latestProjectRef.current, latestSessionRef.current)
      }
      const serialized = await serializeProjectBundle(checkpoint)
      const baseName = checkpoint.project.name.trim().replace(/\s+/g, '-') || 'VibeSeq-project'
      const filename = `${baseName}${emergencySnapshot ? '-recovery' : ''}${PROJECT_BUNDLE_EXTENSION}`
      downloadBlob(new Blob([serialized], { type: PROJECT_BUNDLE_MIME_TYPE }), filename)
      setProjectMenuOpen(false)
      setToast(emergencySnapshot
        ? 'Recovery bundle exported from the current in-memory workspace · durable save is still unresolved'
        : 'Portable project exported · arrangement, candidates, jobs, and media included')
    } catch (error) {
      setToast(`Project bundle export blocked: ${(error as Error).message}`)
    }
  }

  const retryDurableSave = async () => {
    try {
      await flushWorkspaceSave()
      clearDurabilityIssue()
      setPersistenceLabel(persistenceLabelFor(persistence.getBackend()))
      setToast('Current workspace saved to durable local storage')
    } catch (error) {
      void reportDurabilityIssue(error)
      setToast(`Durable save still unavailable: ${(error as Error).message}`)
    }
  }

  const importProjectBundle = async (file?: File) => {
    if (!file) {
      bundleInputRef.current?.click()
      return
    }
    try {
      setToast('Validating project schema and media integrity…')
      const verified = await deserializeProjectBundle(await file.text())
      await flushWorkspaceSave()
      const imported = await persistence.importWorkspace(verified)
      commitCheckpointToUi(imported)
      setRecoveryCheckpoint(null)
      recoveryCheckpointRef.current = null
      persistenceReadyRef.current = true
      setPersistenceLabel(persistenceLabelFor(persistence.getBackend()))
      setProjectMenuOpen(false)
      setToast(`Imported ${imported.project.name} · portable media verified`)
    } catch (error) {
      const pendingRecovery = await loadPendingRecovery().catch(() => undefined)
      if (pendingRecovery) {
        setRecoveryCheckpoint(pendingRecovery)
        recoveryCheckpointRef.current = pendingRecovery
        persistenceReadyRef.current = false
        setPersistenceLabel('Recovery checkpoint needs a decision')
      }
      setToast(`Project bundle import failed · current project kept: ${(error as Error).message}`)
    }
  }

  const openProjectMenu = async () => {
    let saveError: unknown
    try {
      await flushWorkspaceSave()
    } catch (error) {
      saveError = error
      void reportDurabilityIssue(error)
    }
    try {
      setProjectSummaries(await persistence.list())
    } catch (error) {
      setProjectSummaries([])
      if (!saveError) saveError = error
    }
    setProjectMenuOpen(true)
    if (saveError) {
      setToast('Durable save is unresolved · project switching stays blocked, but a recovery bundle can be exported')
    }
  }

  const applyCheckpoint = async (storedCheckpoint: ProjectCheckpoint) =>
    commitCheckpointToUi(await verifyCheckpointMedia(storedCheckpoint))

  const recoverInterruptedSave = async () => {
    if (!recoveryCheckpoint) return
    try {
      const recovered = await persistence.recover(recoveryCheckpoint.project.id)
      if (!recovered) throw new Error('The recovery checkpoint is no longer available')
      await applyCheckpoint(recovered)
      const nextRecovery = await loadPendingRecovery()
      setRecoveryCheckpoint(nextRecovery ?? null)
      recoveryCheckpointRef.current = nextRecovery ?? null
      persistenceReadyRef.current = !nextRecovery
      setPersistenceLabel(nextRecovery
        ? 'Another recovery checkpoint needs a decision'
        : persistenceLabelFor(persistence.getBackend()))
      setToast(nextRecovery
        ? 'Recovered the complete interrupted workspace · another checkpoint still needs a decision'
        : 'Recovered the complete interrupted workspace')
    } catch (error) {
      setToast(`Recovery failed: ${(error as Error).message}`)
    }
  }

  const discardInterruptedSave = async () => {
    if (!recoveryCheckpoint) return
    try {
      await persistence.discardRecovery(recoveryCheckpoint.project.id)
      const nextRecovery = await loadPendingRecovery()
      setRecoveryCheckpoint(nextRecovery ?? null)
      recoveryCheckpointRef.current = nextRecovery ?? null
      persistenceReadyRef.current = !nextRecovery
      if (!nextRecovery) setResumeJobId(activeJob?.job.id ?? null)
      setPersistenceLabel(nextRecovery
        ? 'Another recovery checkpoint needs a decision'
        : persistenceLabelFor(persistence.getBackend()))
      setToast(nextRecovery
        ? 'Discarded that interrupted save · another checkpoint still needs a decision'
        : 'Kept the last acknowledged project checkpoint')
    } catch (error) {
      setToast(`Could not discard recovery: ${(error as Error).message}`)
    }
  }

  const createNewProject = async () => {
    try {
      await flushWorkspaceSave()
      const next = createBlankProject({ id: makeId('project') })
      const checkpoint = await persistence.saveWorkspace(next, { candidates: [] })
      commitCheckpointToUi(checkpoint)
      setProjectMenuOpen(false)
      setPersistenceLabel(persistenceLabelFor(persistence.getBackend()))
      setToast('New local project created')
    } catch (error) {
      setToast(`New project blocked · current project kept: ${(error as Error).message}`)
    }
  }

  const openLocalProject = async (projectId: string) => {
    try {
      await flushWorkspaceSave()
      const [next, storedRecovery] = await Promise.all([persistence.loadWorkspace(projectId), persistence.loadRecovery(projectId)])
      if (!next) throw new Error('The selected project is no longer available')
      const recovery = storedRecovery ? await verifyCheckpointMedia(storedRecovery) : undefined
      await applyCheckpoint(next)
      if (recovery) setResumeJobId(null)
      setProjectMenuOpen(false)
      setRecoveryCheckpoint(recovery ?? null)
      persistenceReadyRef.current = !recovery
      setPersistenceLabel(recovery ? 'Recovery checkpoint needs a decision' : persistenceLabelFor(persistence.getBackend()))
      setToast(`Opened ${next.project.name}`)
    } catch (error) {
      setToast(`Could not open project: ${(error as Error).message}`)
    }
  }

  const deleteLocalProject = async (target: ProjectSummary) => {
    if (projectDeleting) return
    setProjectDeleting(true)
    const deletingCurrentProject = target.id === latestProjectRef.current.id
    try {
      // Drain all queued saves before removing storage so an older write cannot
      // recreate the project after deletion.
      await flushWorkspaceSave()

      if (deletingCurrentProject && activeJobRef.current) {
        await cancelActiveJob()
        if (activeJobRef.current) {
          throw new Error('the active inference job could not be cancelled safely')
        }
      }

      let replacementRecovery: ProjectCheckpoint | undefined
      if (deletingCurrentProject) {
        const alternative = (await persistence.list()).find((summary) => summary.id !== target.id)
        let replacement: ProjectCheckpoint
        if (alternative) {
          const [stored, storedRecovery] = await Promise.all([
            persistence.loadWorkspace(alternative.id),
            persistence.loadRecovery(alternative.id),
          ])
          if (!stored) throw new Error('the replacement project is no longer available')
          replacement = await verifyCheckpointMedia(stored)
          replacementRecovery = storedRecovery
            ? await verifyCheckpointMedia(storedRecovery)
            : undefined
        } else {
          const blank = createBlankProject({ id: makeId('project') })
          replacement = await persistence.saveWorkspace(blank, { candidates: [] })
        }
        commitCheckpointToUi(replacement)
        setRecoveryCheckpoint(replacementRecovery ?? null)
        recoveryCheckpointRef.current = replacementRecovery ?? null
        persistenceReadyRef.current = !replacementRecovery
        setPersistenceLabel(replacementRecovery
          ? 'Recovery checkpoint needs a decision'
          : persistenceLabelFor(persistence.getBackend()))
      }

      await persistence.remove(target.id)
      const remaining = await persistence.list()
      if (remaining.some((summary) => summary.id === target.id)) {
        throw new Error('a persistence backend still contains the project')
      }
      setProjectSummaries(remaining)
      setProjectDeleteTarget(null)
      if (deletingCurrentProject) setProjectMenuOpen(false)
      setToast(`Deleted ${target.name} · global Sound Library sounds were kept`)
    } catch (error) {
      setToast(`Project deletion could not be confirmed · retry before assuming ${target.name} is removed: ${(error as Error).message}`)
    } finally {
      setProjectDeleting(false)
    }
  }

  const renameProject = (name: string) => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === project.name) return
    void mutate('Rename project', (draft) => { draft.name = trimmed }, 'project:name')
  }

  const changeProjectTimeSignature = (timeSignature: TimeSignature): Promise<void> =>
    mutate('Change time signature', (draft) => {
      draft.timeSignature = { ...timeSignature }
    }, 'project:time-signature')

  const collectPcmAssets = async (
    targetProject: Project = project,
    onProgress?: (completed: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<Map<string, PcmAudioAsset>> => {
    signal?.throwIfAborted()
    const verified = await verifyProjectAudioAssets(targetProject)
    signal?.throwIfAborted()
    const context = new AudioContext()
    const pcm = new Map<string, PcmAudioAsset>()
    const builtinMidiAssets = targetProject.tracks.some((track) => (
      track.kind === 'midi' && track.midi.instrument.kind === 'drums'
    )) ? BUILTIN_CHAOS_DRUM_ASSETS : []
    const totalAssets = verified.length + builtinMidiAssets.length
    try {
      onProgress?.(0, totalAssets)
      for (let index = 0; index < verified.length; index += 1) {
        signal?.throwIfAborted()
        const { asset } = verified[index]
        const media = asset.blob ?? asset.bytes!
        const bytes = media instanceof Blob ? await media.arrayBuffer() : media
        let buffer: AudioBuffer
        try { buffer = await context.decodeAudioData(bytes.slice(0)) }
        catch (error) { throw new Error(`${asset.name}: encoded audio could not be decoded`, { cause: error }) }
        signal?.throwIfAborted()
        pcm.set(asset.id, audioBufferToPcmAsset(asset.id, buffer))
        onProgress?.(index + 1, totalAssets)
      }
      for (let index = 0; index < builtinMidiAssets.length; index += 1) {
        signal?.throwIfAborted()
        const source = builtinMidiAssets[index]
        let buffer: AudioBuffer
        try { buffer = await decodeBuiltinMidiAsset(context, source) }
        catch (error) { throw new Error(`${source.id}: built-in drum sample could not be decoded`, { cause: error }) }
        signal?.throwIfAborted()
        pcm.set(source.id, audioBufferToPcmAsset(source.id, buffer))
        onProgress?.(verified.length + index + 1, totalAssets)
      }
      return pcm
    } finally {
      await context.close().catch(() => undefined)
    }
  }

  const exportMix = async (
    target: WavExportTarget,
    bitDepth: 16 | 24 | 32,
    protectPeaks: boolean,
    sampleRate: ProjectSampleRate,
  ) => {
    if (mixExportAbortRef.current) return
    const controller = new AbortController()
    mixExportAbortRef.current = controller
    setMixExportProgress({ phase: 'preparing', progress: 0 })
    try {
      const checkpoint = await flushWorkspaceSave()
      const exportProject = checkpoint.project
      const prepared = prepareWavExport(exportProject, target)
      if (controller.signal.aborted) throw new DOMException('WAV export cancelled', 'AbortError')
      setMixExportProgress({ phase: 'decoding', progress: 0.02 })
      const pcm = await collectPcmAssets(prepared.project, (completed, total) => {
        const fraction = total > 0 ? completed / total : 1
        setMixExportProgress({ phase: 'decoding', progress: 0.02 + fraction * 0.08 })
      }, controller.signal)
      const rendered = await exportWavInWorker(prepared.project, pcm, {
        ...prepared.range,
        sampleRate,
        bitDepth,
        protectPeaks,
        rejectSilent: true,
        rejectUnprotectedClipping: true,
      }, {
        signal: controller.signal,
        onProgress: (progress) => setMixExportProgress({
          phase: progress.phase,
          progress: 0.1 + progress.progress * 0.9,
        }),
      })
      const blob = new Blob([rendered.wav], { type: 'audio/wav' })
      const depthLabel = bitDepth === 16 ? '16-bit PCM + TPDF' : bitDepth === 24 ? '24-bit PCM' : '32-bit float'
      const rateLabel = sampleRate === 44_100 ? '44.1k' : '48k'
      const peakLabel = `${(20 * Math.log10(rendered.interSamplePeak)).toFixed(1)} dBFS 4× inter-sample estimate`
      const protectionLabel = rendered.peakProtectionApplied
        ? `peak protection ${rendered.peakAttenuationDb.toFixed(2)} dB`
        : 'peak protection not applied'
      downloadBlob(blob, `${safeExportFilenamePart(exportProject.name)}-${prepared.filenameScope}-${rateLabel}-${bitDepth}bit.wav`)
      setToast(`${prepared.label} rendered locally · ${rateLabel} · ${depthLabel} · ${peakLabel} · ${protectionLabel}`)
      setExportOpen(false)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') setToast('WAV export cancelled')
      else setToast(`Export blocked: ${(error as Error).message}`)
    } finally {
      if (mixExportAbortRef.current === controller) {
        mixExportAbortRef.current = null
        setMixExportProgress(null)
      }
    }
  }

  const cancelMixExport = () => {
    if (!mixExportAbortRef.current) return
    setMixExportProgress((current) => ({ phase: 'cancelling', progress: current?.progress ?? 0 }))
    mixExportAbortRef.current.abort()
  }

  const exportAllTracksZip = async (
    bitDepth: 16 | 24 | 32,
    protectPeaks: boolean,
    sampleRate: ProjectSampleRate,
  ) => {
    if (mixExportAbortRef.current) return
    const controller = new AbortController()
    mixExportAbortRef.current = controller
    setMixExportProgress({ phase: 'preparing', progress: 0 })
    try {
      const checkpoint = await flushWorkspaceSave()
      const exportProject = checkpoint.project
      if (exportProject.tracks.length === 0) throw new Error('Add an Audio or MIDI track before exporting stems')
      if (controller.signal.aborted) throw new DOMException('Track stem export cancelled', 'AbortError')
      setMixExportProgress({ phase: 'decoding', progress: 0.02 })
      const pcm = await collectPcmAssets(exportProject, (completed, total) => {
        const fraction = total > 0 ? completed / total : 1
        setMixExportProgress({ phase: 'decoding', progress: 0.02 + fraction * 0.08 })
      }, controller.signal)
      const rendered = await exportTrackStemsZipInWorker(exportProject, pcm, {
        sampleRate,
        bitDepth,
        protectPeaks,
        rejectUnprotectedClipping: true,
      }, {
        signal: controller.signal,
        onProgress: (progress) => setMixExportProgress({
          phase: progress.phase,
          progress: 0.1 + progress.progress * 0.9,
        }),
      })
      const rateLabel = sampleRate === 44_100 ? '44.1k' : '48k'
      const filename = `${safeExportFilenamePart(exportProject.name)}-individual-tracks-${rateLabel}-${bitDepth}bit.zip`
      downloadBlob(new Blob([rendered.zip], { type: 'application/zip' }), filename)
      setToast(`${rendered.manifest.tracks.length} aligned track stems packaged locally · ${rateLabel} · ${bitDepth}-bit`)
      setExportOpen(false)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') setToast('Track stem export cancelled')
      else setToast(`Export blocked: ${(error as Error).message}`)
    } finally {
      if (mixExportAbortRef.current === controller) {
        mixExportAbortRef.current = null
        setMixExportProgress(null)
      }
    }
  }

  const closeExportDialog = () => {
    mixExportAbortRef.current?.abort()
    setExportOpen(false)
  }

  const exportMidi = async () => {
    try {
      const checkpoint = await flushWorkspaceSave()
      downloadBlob(exportMidiBlob(checkpoint.project), `${checkpoint.project.name.replace(/\s+/g, '-')}.mid`)
      setToast('MIDI exported')
      setExportOpen(false)
    } catch (error) {
      setToast(`Export blocked: ${(error as Error).message}`)
    }
  }

  const mobileSurfaceChange = (surface: MobileSurface) => {
    setSourceOpen(false)
    setInspectorOpen(false)
    setDetailOpen(false)
    setMobileSurface(surface)
    if (surface === 'create') setSourceOpen(true)
    if (surface === 'detail') setDetailOpen(true)
  }

  const reuseGenerationPrompt = useCallback((value: string) => {
    setPrompt(value)
    setSourceOpen(true)
    setInspectorOpen(false)
    setDetailOpen(false)
    setDetailExpanded(false)
    setMobileSurface('create')
    setPromptFocusRequest((request) => request + 1)
  }, [])

  useEffect(() => {
    if (!resumeJobId || recoveryCheckpoint || !persistenceReady) return
    const sessionJob = activeJob?.job
    if (!sessionJob || sessionJob.id !== resumeJobId) { setResumeJobId(null); return }
    const projectJob = project.jobs.find((job) => job.id === resumeJobId)
    if (!projectJob) { clearPublishedActiveJob(resumeJobId); setResumeJobId(null); return }
    const controller = new AbortController()
    activeAbortRef.current = controller
    activeJobRef.current = sessionJob

    const resume = async () => {
      try {
        if (sessionJob.kind === 'generate') {
          const completed = await waitForJob<GeneratedAssetResult>(sessionJob.id, (next) => {
            publishActiveJob({ label: 'Reconnecting to generation', job: next as InferenceJob<unknown> })
          }, controller.signal)
          if (!completed.result) throw new Error('Recovered generation has no audio result')
          const result = completed.result
          let libraryFailure: string | null = null
          if (!candidates.some((candidate) => candidate.jobId === completed.id)) {
            const response = await fetch(result.assetUrl, { signal: controller.signal })
            if (!response.ok) throw new Error(`Recovered audio request returned ${response.status}`)
            const media = await response.blob()
            const mediaIdentity = await establishMediaIdentity(media)
            const recoveredCandidate: GeneratedCandidate = {
              id: makeId('candidate'),
              name: generatedClipName(projectJob.input.prompt ?? result.prompt ?? '', result.duration),
              prompt: projectJob.input.prompt ?? result.prompt ?? '',
              duration: result.duration,
              seed: projectJob.input.seed,
              generationLength: projectJob.input.generationLength,
              provider: result.provider,
              device: result.device,
              model: result.model ?? undefined,
              modelId: result.modelId ?? undefined,
              modelRevision: result.modelRevision ?? undefined,
              codeRevision: result.codeRevision ?? undefined,
              runtime: result.runtime ?? undefined,
              route: result.route ?? undefined,
              sourcePeak: result.sourcePeak,
              outputPeak: result.outputPeak,
              peakProtectionApplied: result.peakProtectionApplied,
              peakAttenuationDb: result.peakAttenuationDb,
              assetId: result.assetId,
              assetUrl: result.assetUrl,
              sampleRate: result.sampleRate,
              mimeType: media.type || 'audio/wav',
              peaks: normalizePeaks(result.peaks),
              jobId: completed.id,
              blob: media,
              ...mediaIdentity,
            }
            setCandidates((current) => current.some((candidate) => candidate.jobId === completed.id) ? current : [recoveredCandidate, ...current])
            libraryFailure = await storeGeneratedCandidateInLibrary(recoveredCandidate, media)
          }
          await updateProjectJob(completed.id, { state: 'completed', progress: 1, output: { assetId: result.assetId }, error: null })
          setToast(libraryFailure
            ? `Generation reconnected · candidate recovered, Library save failed: ${libraryFailure}`
            : 'Generation reconnected · candidate recovered in the global Sound Library')
        } else {
          const completed = await waitForJob<TranscriptionResult>(sessionJob.id, (next) => {
            publishActiveJob({ label: 'Reconnecting to MIDI extraction', job: next as InferenceJob<unknown> })
          }, controller.signal)
          if (!completed.result) throw new Error('Recovered extraction has no MIDI result')
          const result = completed.result
          const alreadyCommitted = project.tracks.some((track) => track.clips.some((clip) => clip.provenance.jobId === completed.id))
          if (!alreadyCommitted) {
            const trackId = makeId('track-midi')
            const clipId = makeId('clip-midi')
            let created = false
            let legacySourceMissing = false
            let committedNoteCount = 0
            await mutate('Commit recovered MIDI extraction', (draft) => {
              if (draft.tracks.some((track) => track.clips.some((clip) => clip.provenance.jobId === completed.id))) return
              let submission = projectJob.input.midiExtraction
              if (!submission) {
                const sourceTrack = draft.tracks.find((track) => track.id === projectJob.input.trackId)
                const sourceClip = sourceTrack?.clips.find((clip) => clip.id === projectJob.input.clipId)
                if (!sourceTrack || sourceClip?.kind !== 'audio') {
                  legacySourceMissing = true
                  return
                }
                // Jobs saved before submission snapshots can only use the best
                // surviving source state. Newly submitted jobs never take this path.
                submission = captureMidiExtractionSnapshot(sourceClip, sourceTrack.id, draft.bpm)
              }
              const midiClip = createExtractedMidiClip({
                clipId,
                jobId: completed.id,
                createdAt: new Date().toISOString(),
                snapshot: submission,
                result,
              })
              committedNoteCount = midiClip.notes.length
              const sourceIndex = draft.tracks.findIndex((track) => track.id === submission.sourceTrackId)
              draft.tracks.splice(sourceIndex < 0 ? draft.tracks.length : sourceIndex + 1, 0, { id: trackId, name: 'Extracted MIDI', kind: 'midi', midi: createMidiTrackSettingsForTranscription(result.notes), color: '#5DD6D1', gain: 0.75, pan: 0, mute: false, solo: false, clips: [midiClip] })
              created = true
            })
            if (created) {
              await updateProjectJob(completed.id, { state: 'completed', progress: 1, output: { assetId: result.midiAssetId, clipId, trackId }, error: null })
              selectClip(clipId, trackId)
              setToast(`MIDI extraction reconnected · ${extractionNoteSummary(result.notes.length, committedNoteCount)}`)
            } else if (legacySourceMissing) {
              await updateProjectJob(completed.id, { state: 'completed', progress: 1, output: { assetId: result.midiAssetId }, error: null })
              setToast('Legacy MIDI extraction finished, but its unsnapshotted source region no longer exists')
            }
          }
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          await recordTerminalJobError(sessionJob.id, error)
          setToast(error instanceof InferenceJobTerminalError && error.job.status === 'cancelled'
            ? 'Inference job was cancelled'
            : `Could not resume inference job: ${(error as Error).message}`)
        }
      } finally {
        const ownsResume = activeAbortRef.current === controller
        if (ownsResume) {
          activeAbortRef.current = null
          clearPublishedActiveJob(sessionJob.id)
          setResumeJobId((current) => current === sessionJob.id ? null : current)
        }
      }
    }
    void resume()
    return () => controller.abort()
    // This effect is intentionally keyed by the one persisted job selected for resume.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeJobAttempt, resumeJobId])

  shortcutHandlerRef.current = (event: KeyboardEvent) => {
    if (!persistenceReady) return
    if (event.defaultPrevented) return
    const target = event.target as HTMLElement | null
    if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
    if (event.repeat) return
    if (event.code === 'Space') { event.preventDefault(); void togglePlayback() }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) void history.redo(); else void history.undo()
    }
    if (event.key.toLowerCase() === 'g') {
      setSnapGrid((current) => {
        if (current === 'free') return lastSnapGridRef.current
        lastSnapGridRef.current = current
        return 'free'
      })
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 's' && selectedClipId) {
      event.preventDefault()
      void splitSelected()
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedClipId) { event.preventDefault(); void deleteSelected() }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd' && selectedClipId) { event.preventDefault(); void duplicateSelected() }
    if (event.key === '0') setZoom(1)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => shortcutHandlerRef.current(event)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const requiredStorageLabel = formatStorageBytes(durabilityIssue?.requiredBytes)
  const availableStorageLabel = formatStorageBytes(durabilityIssue?.availableBytes)

  return (
    <div className={`app-shell mobile-surface-${mobileSurface}`} aria-busy={!persistenceReady}>
      {!persistenceReady && <div className="loading-cover" role="status"><HardDrive /><span>Opening the local project journal…</span></div>}
      <Transport
        project={project}
        playheadBeat={playheadBeat}
        playing={playing}
        snapGrid={snapGrid}
        canUndo={history.canUndo}
        canRedo={history.canRedo}
        health={health}
        generationProvider={generationProvider}
        masterLevel={meters.master}
        onTogglePlay={() => void togglePlayback()}
        onStop={() => playbackRef.current?.stop(0)}
        onSeekStart={() => { playbackRef.current?.seek(0); updatePlayhead(0) }}
        onToggleLoop={() => void mutate('Toggle loop', (draft) => { draft.loop.enabled = !draft.loop.enabled })}
        onSnapGridChange={(grid) => {
          if (grid !== 'free') lastSnapGridRef.current = grid
          setSnapGrid(grid)
        }}
        onUndo={() => void history.undo()}
        onRedo={() => void history.redo()}
        onBpmChange={changeProjectTempo}
        onExport={() => setExportOpen(true)}
        onOpenProject={() => void openProjectMenu()}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className={`studio-grid ${detailOpen || mobileSurface === 'detail' ? '' : 'is-detail-collapsed'}`}>
        <SourcePanel
          prompt={prompt}
          promptFocusRequest={promptFocusRequest}
          generationLength={generationLength}
          seed={generationSeed}
          bpm={project.bpm}
          timeSignature={project.timeSignature}
          candidates={candidates}
          libraryItems={libraryItems}
          libraryLoading={libraryLoading}
          libraryError={libraryError}
          previewingCandidateId={previewCandidateId}
          previewingLibraryItemId={previewingLibraryItemId}
          job={activeJob}
          open={sourceOpen || mobileSurface === 'create'}
          onPromptChange={setPrompt}
          onGenerationLengthChange={setGenerationLength}
          onSeedChange={setGenerationSeed}
          onGenerate={() => void runGeneration()}
          onCancel={() => void cancelActiveJob()}
          onPlace={(candidate) => void placeCandidate(candidate)}
          onPreview={(candidate) => void previewCandidate(candidate)}
          onDownload={(candidate) => void downloadCandidate(candidate)}
          onImport={(file) => void importAudio(file)}
          onRefreshLibrary={() => void refreshSoundLibrary()}
          onPlaceLibrary={(item) => void placeLibrarySound(item)}
          onPreviewLibrary={(item) => void previewLibrarySound(item)}
          onDownloadLibrary={(item) => void downloadLibrarySound(item)}
          onDeleteLibrary={(item) => void deleteLibrarySound(item)}
          placeAtLoopStart={project.loop.enabled}
          onClose={() => { setSourceOpen(false); setMobileSurface('arrange') }}
        />

        <Arrangement
          project={project}
          selectedClipId={selectedClipId}
          selectedTrackId={selectedTrackId}
          revealRequest={arrangementRevealRequest}
          playheadBeat={playheadBeat}
          zoom={zoom}
          snapping={snapping}
          snapDivision={snapDivision ?? undefined}
          trackLevels={meters.tracks}
          canUndo={history.canUndo}
          canRedo={history.canRedo}
          onSelectClip={selectClip}
          onSelectTrack={selectTrack}
          onSeek={(beat) => { updatePlayhead(beat); playbackRef.current?.seek(beat) }}
          onEditClip={editClip}
          onMoveClip={moveClip}
          onOpenClipDetail={openClipDetail}
          onOpenClipCommands={(clipId, trackId, anchor) => {
            selectClip(clipId, trackId)
            setClipCommand({ clipId, trackId, anchor })
          }}
          onToggleTrack={toggleTrack}
          onTrackGain={setTrackGain}
          onMoveTrack={moveTrack}
          onAddTrack={addTrack}
          onToggleLoop={() => void mutate('Toggle loop', (draft) => { draft.loop.enabled = !draft.loop.enabled })}
          onEditLoop={(startBeat, endBeat) => void mutate('Edit loop range', (draft) => { draft.loop = { enabled: true, startBeat, endBeat } }, 'project:loop-range')}
          onUndo={() => void history.undo()}
          onRedo={() => void history.redo()}
          onZoomChange={setZoom}
          onDropAudioSource={dropAudioSource}
        />

        <Inspector
          track={selectedTrack}
          clip={selected?.clip}
          playheadBeat={playheadBeat}
          bpm={project.bpm}
          open={inspectorOpen}
          extracting={activeJob?.job.kind === 'transcribe'}
          busy={Boolean(activeJob)}
          tempoAnalyzing={tempoAnalyzing}
          tempoAnalysis={tempoAnalysis && tempoAnalysis.clipId === selected?.clip.id ? tempoAnalysis.result : null}
          tempoAnalysisError={tempoAnalysisError}
          linkedRegion={linkedRegion}
          onGain={(gain) => editSelectedProperty({ gain }, 'gain')}
          onTrackGain={(gain) => selectedTrack && setTrackGain(selectedTrack.id, gain)}
          onTrackPan={(pan) => selectedTrack && setTrackPan(selectedTrack.id, pan)}
          onToggleTrack={(field) => selectedTrack && toggleTrack(selectedTrack.id, field)}
          onMidiSettings={(settings) => selectedTrack?.kind === 'midi' && setMidiTrackSettings(selectedTrack.id, settings)}
          onRenameTrack={(name) => selectedTrack && renameTrack(selectedTrack.id, name)}
          onDeleteTrack={() => selectedTrack && deleteTrack(selectedTrack.id)}
          onRenameRegion={(name) => selected && renameRegion(selected.clip.id, name)}
          onFade={(edge, value) => editSelectedProperty({ [edge]: value }, edge)}
          onToggleClipMute={toggleSelectedClipMute}
          onToggleSourceLoop={toggleSelectedSourceLoop}
          onExtract={() => void extractMidi()}
          onAnalyzeTempo={() => void analyzeSelectedAudioTempo()}
          onCancelTempoAnalysis={cancelTempoAnalysis}
          onApplyTempo={applyDetectedTempo}
          onOpenLinkedRegion={openLinkedRegion}
          onReusePrompt={reuseGenerationPrompt}
          onSplit={() => void splitSelected()}
          onDuplicate={() => void duplicateSelected()}
          onDelete={() => void deleteSelected()}
          onClose={() => setInspectorOpen(false)}
        />

        <DetailEditor
          clip={selected?.clip}
          track={selected?.track}
          asset={selectedAsset}
          playheadBeat={playheadBeat}
          bpm={project.bpm}
          timeSignature={project.timeSignature}
          snapping={snapping}
          snapDivision={snapDivision ?? undefined}
          open={detailOpen || mobileSurface === 'detail'}
          expanded={detailExpanded}
          onEditNote={editNote}
          onEditNotes={editNotes}
          onDeleteNote={deleteNote}
          onDeleteNotes={deleteNotes}
          onAddNote={addNote}
          onQuantize={quantizeSelected}
          onSeek={(beat) => { updatePlayhead(beat); playbackRef.current?.seek(beat) }}
          onEditAudio={(patch) => editSelectedProperty(
            patch,
            patch.fadeIn !== undefined ? 'fadeIn' : 'fadeOut',
          )}
          onAuditionMidiNote={auditionMidiNote}
          onExpand={() => { setDetailOpen(true); setDetailExpanded((value) => !value); setMobileSurface('detail') }}
          onClose={() => { setDetailOpen(false); setDetailExpanded(false); if (mobileSurface === 'detail') setMobileSurface('arrange') }}
        />

        <div className={`mobile-context-bar ${selected ? 'is-visible' : ''}`}>
          <button onClick={() => { setSourceOpen(false); setInspectorOpen(false); setDetailExpanded(false); setDetailOpen(true); setMobileSurface('detail') }}><FileAudio />Edit</button>
          {selected?.clip.kind === 'audio' && <button onClick={() => void extractMidi()}><Music2 />Extract MIDI</button>}
          <button onClick={() => void mutate('Set loop range', (draft) => { if (selected) { draft.loop = { enabled: true, startBeat: selected.clip.startBeat, endBeat: selected.clip.startBeat + selected.clip.durationBeats } } })}><Repeat2 />Loop range</button>
          <button onClick={() => { setSourceOpen(false); setDetailOpen(false); setInspectorOpen(true) }}><ChevronDown />More</button>
        </div>

        {activeJob && <div className="global-job-pill" role="status"><button className="global-job-open" onClick={() => mobileSurfaceChange('create')}><Sparkles /><span>{activeJob.label}</span><b>{Math.round(activeJob.job.progress * 100)}%</b></button><span className="global-job-progress"><i style={{ width: `${Math.round(activeJob.job.progress * 100)}%` }} /></span><button className="global-job-cancel" onClick={() => void cancelActiveJob()} aria-label="Cancel inference job"><CircleStop /></button></div>}

        {mobileSurface === 'mix' && <MobileMixer project={project} trackLevels={meters.tracks} masterLevel={meters.master} onToggleTrack={toggleTrack} onTrackGain={setTrackGain} onTrackPan={setTrackPan} onMasterGain={setMasterGain} />}
      </div>

      <footer className="status-bar"><span><HardDrive />{persistenceLabel}</span><span>{snapping ? `Snap ${snapGridLabel(snapGrid)}` : 'Free placement'}</span><button type="button" className="status-detail-toggle" disabled={!selected} onClick={() => { if (!selected) return; setDetailOpen((value) => !value); if (detailOpen) setDetailExpanded(false) }}>{detailOpen ? 'Hide detail' : 'Show detail'}</button><div className="zoom-control"><button onClick={() => setZoom((value) => Math.max(1, value - 0.25))}>−</button><input aria-label="Timeline zoom" type="range" min="1" max="3" step="0.25" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /><button onClick={() => setZoom((value) => Math.min(3, value + 0.25))}>+</button></div><span>{selected ? `Region · ${selected.clip.name}` : selectedTrack ? `Track · ${selectedTrack.name}` : 'No selection'}</span></footer>
      <MobileNav active={mobileSurface} onChange={mobileSurfaceChange} />
      {durabilityIssue && <aside className="durability-alert" role="alert" aria-label="Local save requires attention">
        <HardDrive aria-hidden="true" />
        <div><b>Current work is not durably saved</b><span>{durabilityIssue.message}</span>{requiredStorageLabel && <small>Workspace needs about {requiredStorageLabel}{availableStorageLabel ? ` · browser reports ${availableStorageLabel} available` : ''}</small>}</div>
        <button type="button" onClick={() => void retryDurableSave()}>Retry save</button>
        <button type="button" className="primary-button" onClick={() => void exportProjectBundle()}>Export recovery bundle</button>
      </aside>}
      <input ref={importInputRef} type="file" accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importAudio(file); event.currentTarget.value = '' }} />
      <input ref={bundleInputRef} type="file" accept={`${PROJECT_BUNDLE_EXTENSION},${PROJECT_BUNDLE_MIME_TYPE},application/json`} hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importProjectBundle(file); event.currentTarget.value = '' }} />

      {clipCommand && commandTarget && <ClipCommandMenu
        anchor={clipCommand.anchor}
        clipKind={commandTarget.clip.kind}
        clipName={commandTarget.clip.name}
        clipMuted={Boolean(commandTarget.clip.muted)}
        sourceLoopEnabled={Boolean(commandTarget.clip.sourceLoop)}
        splitLabel={musicalPositionLabel(playheadBeat, project.timeSignature)}
        canSplit={playheadBeat > commandTarget.clip.startBeat && playheadBeat < commandTarget.clip.startBeat + commandTarget.clip.durationBeats}
        inferenceBusy={Boolean(activeJob)}
        onOpenDetail={() => openClipDetail(commandTarget.clip.id, commandTarget.track.id)}
        onSplit={() => void splitSelected()}
        onDuplicate={() => void duplicateSelected()}
        onToggleMute={toggleSelectedClipMute}
        onToggleSourceLoop={toggleSelectedSourceLoop}
        onExtractMidi={() => void extractMidi()}
        onDelete={() => void deleteSelected()}
        onClose={() => setClipCommand(null)}
      />}

      {pendingMidiSplit && <MidiSplitDialog
        affectedNotes={pendingMidiSplit.affectedNotes}
        positionLabel={musicalPositionLabel(pendingMidiSplit.atBeat, project.timeSignature)}
        onlyKeep={pendingMidiSplit.onlyKeep}
        onChoose={(policy) => {
          const target = pendingMidiSplit
          setPendingMidiSplit(null)
          void commitSplit(target, policy)
        }}
        onClose={() => setPendingMidiSplit(null)}
      />}

      {toast && <div className="toast" role="status" aria-live="polite"><Info />{toast}</div>}
      {recoveryCheckpoint && <RecoveryDialog checkpoint={recoveryCheckpoint} onRecover={() => void recoverInterruptedSave()} onDiscard={() => void discardInterruptedSave()} />}
      {projectMenuOpen && <ProjectDialog
        key={project.id}
        project={project}
        summaries={projectSummaries}
        onClose={() => { setProjectDeleteTarget(null); setProjectMenuOpen(false) }}
        onRename={renameProject}
        onTimeSignatureChange={(timeSignature) => void changeProjectTimeSignature(timeSignature)}
        onCreate={() => void createNewProject()}
        onOpen={(id) => void openLocalProject(id)}
        onDelete={setProjectDeleteTarget}
        onImportAudio={() => { setProjectMenuOpen(false); void importAudio() }}
        onImportBundle={() => { setProjectMenuOpen(false); void importProjectBundle() }}
        onExportBundle={() => void exportProjectBundle()}
        onExportRender={() => { setProjectMenuOpen(false); setExportOpen(true) }}
      />}
      {projectDeleteTarget && <ProjectDeleteDialog
        summary={projectDeleteTarget}
        current={projectDeleteTarget.id === project.id}
        busy={projectDeleting}
        onCancel={() => { if (!projectDeleting) setProjectDeleteTarget(null) }}
        onConfirm={() => void deleteLocalProject(projectDeleteTarget)}
      />}
      {exportOpen && <ExportDialog project={project} progress={mixExportProgress} onClose={closeExportDialog} onSampleRateChange={(sampleRate) => void mutate('Change project sample rate', (draft) => { draft.sampleRate = sampleRate }, 'project:sample-rate')} onExportMix={(scope, bitDepth, protectPeaks, sampleRate) => void exportMix(scope, bitDepth, protectPeaks, sampleRate)} onExportAllTracks={(bitDepth, protectPeaks, sampleRate) => void exportAllTracksZip(bitDepth, protectPeaks, sampleRate)} onCancelMix={cancelMixExport} onExportMidi={() => void exportMidi()} />}
      {settingsOpen && <EngineDialog health={health} generationProvider={generationProvider} transcriptionProvider={transcriptionProvider} onGenerationProvider={setGenerationProvider} onTranscriptionProvider={setTranscriptionProvider} onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

interface ProjectDialogProps {
  project: Project
  summaries: ProjectSummary[]
  onClose: () => void
  onRename: (name: string) => void
  onTimeSignatureChange: (timeSignature: TimeSignature) => void
  onCreate: () => void
  onOpen: (id: string) => void
  onDelete: (summary: ProjectSummary) => void
  onImportAudio: () => void
  onImportBundle: () => void
  onExportBundle: () => void
  onExportRender: () => void
}

function ProjectDialog({
  project,
  summaries,
  onClose,
  onRename,
  onTimeSignatureChange,
  onCreate,
  onOpen,
  onDelete,
  onImportAudio,
  onImportBundle,
  onExportBundle,
  onExportRender,
}: ProjectDialogProps) {
  const [name, setName] = useState(project.name)
  const dialogRef = useModalFocus<HTMLElement>()
  const meterValue = `${project.timeSignature.numerator}/${project.timeSignature.denominator}`
  const meterIsSupported = SUPPORTED_TIME_SIGNATURES.some((signature) =>
    `${signature.numerator}/${signature.denominator}` === meterValue)
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="dialog project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-dialog-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div><p className="eyebrow">LOCAL PROJECTS</p><h2 id="project-dialog-title">Project</h2></div>
          <button autoFocus className="icon-button" type="button" onClick={onClose} aria-label="Close project menu"><X /></button>
        </header>

        <form className="project-name-form" onSubmit={(event) => { event.preventDefault(); onRename(name); onClose() }}>
          <label><span>Project name</span><input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
          <button className="text-button" disabled={!name.trim() || name.trim() === project.name}>Rename</button>
        </form>

        <label className="project-meter-setting">
          <span><b>Time signature</b><small>Shared by bars, ruler positions, generation, and MIDI export</small></span>
          <select
            aria-label="Project time signature"
            value={meterValue}
            onChange={(event) => {
              const selected = SUPPORTED_TIME_SIGNATURES.find((signature) =>
                `${signature.numerator}/${signature.denominator}` === event.target.value)
              if (selected) onTimeSignatureChange({ ...selected })
            }}
          >
            {!meterIsSupported && <option value={meterValue} disabled>{meterValue} · imported</option>}
            {SUPPORTED_TIME_SIGNATURES.map((signature) => {
              const value = `${signature.numerator}/${signature.denominator}`
              return <option key={value} value={value}>{value}</option>
            })}
          </select>
        </label>

        <div className="project-primary-actions">
          <button type="button" onClick={onCreate}><Plus /><span><b>New project</b><small>Start with an empty local arrangement</small></span></button>
          <button type="button" onClick={onImportBundle}><Import /><span><b>Import project bundle</b><small>Validate and restore a complete .vibeseq workspace</small></span></button>
          <button type="button" onClick={onExportBundle}><Download /><span><b>Export project bundle</b><small>Carry arrangement, candidates, jobs, and source media</small></span></button>
          <button type="button" onClick={onImportAudio}><FileAudio /><span><b>Import audio</b><small>Add source media at the playhead</small></span></button>
          <button type="button" onClick={onExportRender}><FileMusic /><span><b>Export render</b><small>Render WAV or MIDI locally</small></span></button>
        </div>

        <section className="local-project-list" aria-label="Saved local projects">
          <div className="section-label"><span>OPEN LOCAL PROJECT</span><FolderOpen /></div>
          {summaries.length === 0
            ? <p>No saved projects were found in this browser.</p>
            : summaries.map((summary) => (
                <div className={`local-project-row ${summary.id === project.id ? 'is-current' : ''}`} key={summary.id}>
                  <button type="button" className="local-project-open" disabled={summary.id === project.id} onClick={() => onOpen(summary.id)}>
                    <span><b>{summary.name}</b><small>{summary.trackCount} tracks · {summary.bpm.toFixed(1)} BPM</small></span>
                    <time dateTime={summary.updatedAt}>{summary.id === project.id ? 'Open now' : new Date(summary.updatedAt).toLocaleDateString()}</time>
                  </button>
                  <button type="button" className="local-project-delete" aria-label={`Delete project ${summary.name}`} title={`Delete ${summary.name}`} onClick={() => onDelete(summary)}><Trash2 /></button>
                </div>
              ))}
        </section>
      </section>
    </div>
  )
}

function RecoveryDialog({ checkpoint, onRecover, onDiscard }: { checkpoint: ProjectCheckpoint; onRecover: () => void; onDiscard: () => void }) {
  const dialogRef = useModalFocus<HTMLElement>()
  return <div className="modal-backdrop recovery-backdrop"><section ref={dialogRef} className="dialog recovery-dialog" role="alertdialog" aria-modal="true" aria-labelledby="recovery-dialog-title" aria-describedby="recovery-dialog-description" tabIndex={-1}><header><div><p className="eyebrow">LOCAL RECOVERY</p><h2 id="recovery-dialog-title">Interrupted save found</h2></div><HardDrive /></header><p id="recovery-dialog-description">A complete workspace journal from {new Date(checkpoint.savedAt).toLocaleString()} is newer than the last acknowledged project. Choose which state to keep; VibeSeq will not overwrite it automatically.</p><div className="recovery-summary"><b>{checkpoint.project.name}</b><span>{checkpoint.project.tracks.length} tracks · {checkpoint.session.candidates.length} unplaced candidates</span></div><div className="recovery-actions"><button onClick={onDiscard}>Keep last saved</button><button autoFocus className="primary-button" onClick={onRecover}>Recover newer work</button></div></section></div>
}

function MobileMixer({ project, trackLevels, masterLevel, onToggleTrack, onTrackGain, onTrackPan, onMasterGain }: { project: Project; trackLevels: Record<string, number>; masterLevel: number; onToggleTrack: (id: string, field: 'mute' | 'solo') => void; onTrackGain: (id: string, gain: number) => void; onTrackPan: (id: string, pan: number) => void; onMasterGain: (gain: number) => void }) {
  return <section className="mobile-mixer panel"><header><div><p className="eyebrow">MIX</p><h2>Track balance</h2></div><div className="mobile-master-meter" role="meter" aria-label="Master peak level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(masterLevel * 100)}><i style={{ height: `${Math.round(masterLevel * 100)}%` }} /></div></header><label className="mobile-master-gain"><span>MASTER</span><input aria-label="Master gain" type="range" min="0" max="1.25" step="0.01" value={project.masterGain} onChange={(event) => onMasterGain(Number(event.target.value))} /><b>{Math.round(project.masterGain * 100)}%</b></label>{project.tracks.length === 0 && <p className="mobile-mixer-empty">Add a track in Arrangement to begin mixing.</p>}{project.tracks.map((track) => <div className="mobile-mixer-row" key={track.id} style={{ '--track-color': track.color } as React.CSSProperties}><span>{track.kind === 'audio' ? <FileAudio /> : <FileMusic />}</span><strong>{track.name}</strong><button aria-label={`Mute ${track.name}`} aria-pressed={track.mute} className={track.mute ? 'is-active' : ''} onClick={() => onToggleTrack(track.id, 'mute')}>M</button><button aria-label={`Solo ${track.name}`} aria-pressed={track.solo} className={track.solo ? 'is-active' : ''} onClick={() => onToggleTrack(track.id, 'solo')}>S</button><div className="mobile-track-meter" role="meter" aria-label={`${track.name} peak level`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((trackLevels[track.id] ?? 0) * 100)}><i style={{ width: `${Math.round((trackLevels[track.id] ?? 0) * 100)}%` }} /></div><label><span>GAIN</span><input aria-label={`${track.name} gain`} type="range" min="0" max="1.25" step="0.01" value={track.gain} onChange={(event) => onTrackGain(track.id, Number(event.target.value))} /></label><label><span>PAN</span><input aria-label={`${track.name} pan`} type="range" min="-1" max="1" step="0.01" value={track.pan} onChange={(event) => onTrackPan(track.id, Number(event.target.value))} /></label></div>)}</section>
}

export default App
