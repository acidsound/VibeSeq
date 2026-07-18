import { CircleAlert, CircleCheck, Download, ExternalLink, FileCheck2, FolderOpen, MonitorCog, Save, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { EngineCapability, InferenceHealth } from '../api/inference'
import { useModalFocus } from '../hooks/useModalFocus'
import { presentEngine } from '../ui/engineHealth'

type EngineDialogProps = {
  health: InferenceHealth | null
  generationProvider: string
  transcriptionProvider: string
  onGenerationProvider: (value: string) => void
  onTranscriptionProvider: (value: string) => void
  onModelInstalled?: () => void | Promise<void>
  onClose: () => void
}

type EngineCapabilityCardProps = {
  title: string
  kind: 'generation' | 'transcription'
  health: InferenceHealth | null
  selectedProvider: string
  options: string[]
  onProvider: (value: string) => void
  onModelInstalled?: () => void | Promise<void>
  modelCachePath?: string
}

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 GB'
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`
}

const openExternal = (event: React.MouseEvent<HTMLAnchorElement>, url: string) => {
  if (!window.vibeseqDesktop) return
  event.preventDefault()
  void window.vibeseqDesktop.openExternal(url)
}

const optionLabel = (provider: string): string => {
  if (provider === 'stable-audio-3') return 'Stable Audio 3 · Medium'
  if (provider === 'muscriptor') return 'MuScriptor · Medium'
  if (provider === 'procedural-demo') return 'Procedural demo · fixture'
  if (provider === 'signal-demo') return 'Signal demo · fixture'
  return provider
}

const capabilityFor = (
  health: InferenceHealth | null,
  kind: 'generation' | 'transcription',
  selectedProvider: string,
): EngineCapability | null => {
  const capability = health?.[kind]
  return capability?.provider === selectedProvider ? capability : null
}

const sourceRevisionUrl = (capability: EngineCapability): string | null => {
  if (!capability.codeRepository) return null
  if (!capability.codeRevision || !capability.codeRepository.includes('github.com')) return capability.codeRepository
  return `${capability.codeRepository.replace(/\/$/, '')}/tree/${capability.codeRevision}`
}

function EngineCapabilityCard({
  title,
  kind,
  health,
  selectedProvider,
  options,
  onProvider,
  onModelInstalled,
  modelCachePath,
}: EngineCapabilityCardProps) {
  const presentation = presentEngine(health, kind, selectedProvider)
  const capability = capabilityFor(health, kind, selectedProvider)
  const sourceUrl = capability ? sourceRevisionUrl(capability) : null
  const statusClass = presentation.ready ? 'is-ready' : presentation.inspected ? 'is-blocked' : 'is-unknown'
  const desktopInstaller = kind === 'generation' && selectedProvider === 'stable-audio-3'
    ? window.vibeseqDesktop?.stableAudio
    : undefined
  const desktopMuscriptorVerifier = kind === 'transcription' && selectedProvider === 'muscriptor'
    ? window.vibeseqDesktop?.muscriptor
    : undefined
  const desktopCudaRuntime = kind === 'transcription' && selectedProvider === 'muscriptor'
    ? window.vibeseqDesktop?.cudaRuntime
    : undefined
  const desktopModelCache = window.vibeseqDesktop?.modelCache
  const muscriptorCudaRuntimeRequired = Boolean(
    desktopMuscriptorVerifier
    && capability?.device === 'cuda'
    && capability.runtimeCompatible === false,
  )
  const showModelInstallation = Boolean(
    capability?.bootstrap
    && (
      capability.weightsCached === false
      || (desktopInstaller && capability.ready === false)
      || muscriptorCudaRuntimeRequired
    ),
  )
  const [installStatus, setInstallStatus] = useState<StableAudioInstallStatus | null>(null)
  const [installProgress, setInstallProgress] = useState<StableAudioInstallProgress | null>(null)
  const [installing, setInstalling] = useState(false)
  const [termsAccepted, setTermsAccepted] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [verifyingMuscriptor, setVerifyingMuscriptor] = useState(false)
  const [muscriptorVerifyError, setMuscriptorVerifyError] = useState<string | null>(null)
  const [cudaRuntimeStatus, setCudaRuntimeStatus] = useState<CudaRuntimeStatus | null>(null)
  const [cudaRuntimeProgress, setCudaRuntimeProgress] = useState<CudaRuntimeProgress | null>(null)
  const [installingCudaRuntime, setInstallingCudaRuntime] = useState(false)
  const [cudaRuntimeError, setCudaRuntimeError] = useState<string | null>(null)

  useEffect(() => {
    if (!desktopInstaller || capability?.ready !== false) return
    let active = true
    void desktopInstaller.status(capability.modelId).then((status) => {
      if (active) setInstallStatus(status)
    }).catch((error) => {
      if (active) setInstallError(error instanceof Error ? error.message : String(error))
    })
    const unsubscribe = desktopInstaller.onProgress((progress) => {
      if (!active) return
      setInstallProgress(progress)
      setInstalling(progress.phase !== 'complete')
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [capability?.modelId, capability?.ready, desktopInstaller])

  useEffect(() => {
    if (!desktopCudaRuntime || !muscriptorCudaRuntimeRequired) return
    let active = true
    void desktopCudaRuntime.status().then((status) => {
      if (active) setCudaRuntimeStatus(status)
    }).catch((error) => {
      if (active) setCudaRuntimeError(error instanceof Error ? error.message : String(error))
    })
    const unsubscribe = desktopCudaRuntime.onProgress((progress) => {
      if (!active) return
      setCudaRuntimeProgress(progress)
      setInstallingCudaRuntime(true)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [desktopCudaRuntime, muscriptorCudaRuntimeRequired])

  const startInstallation = async () => {
    if (!desktopInstaller || !termsAccepted) return
    setInstallError(null)
    setInstalling(true)
    try {
      const status = await desktopInstaller.install({
        accepted: true,
        modelId: capability?.modelId,
      })
      setInstallStatus(status)
      setInstallProgress({
        phase: 'complete',
        asset: null,
        downloadedBytes: status.totalBytes,
        totalBytes: status.totalBytes,
      })
      await onModelInstalled?.()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/abort|cancel/i.test(message)) setInstallError(message)
    } finally {
      setInstalling(false)
    }
  }

  const cancelInstallation = async () => {
    await desktopInstaller?.cancel()
  }

  const verifyMuscriptorFiles = async () => {
    if (!desktopMuscriptorVerifier) return
    setVerifyingMuscriptor(true)
    setMuscriptorVerifyError(null)
    try {
      const result = await desktopMuscriptorVerifier.verifyCache()
      if (result.verified) await onModelInstalled?.()
    } catch {
      setMuscriptorVerifyError('Verification failed. Check that config.json and model.safetensors are directly inside SAVE CACHE UNDER, then try again.')
    } finally {
      setVerifyingMuscriptor(false)
    }
  }

  const installMuscriptorCudaRuntime = async () => {
    if (!desktopCudaRuntime) return
    setCudaRuntimeError(null)
    setInstallingCudaRuntime(true)
    try {
      const status = await desktopCudaRuntime.install()
      setCudaRuntimeStatus(status)
      await onModelInstalled?.()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/abort|cancel/i.test(message)) setCudaRuntimeError(message)
    } finally {
      setInstallingCudaRuntime(false)
    }
  }

  const cancelMuscriptorCudaRuntime = async () => {
    await desktopCudaRuntime?.cancel()
  }

  const muscriptorRevision = capability?.bootstrap?.revision || capability?.modelRevision
  const muscriptorRepository = capability?.bootstrap?.modelId || capability?.modelId
  const muscriptorRevisionRoot = muscriptorRepository && muscriptorRevision
    ? `https://huggingface.co/${muscriptorRepository}/blob/${muscriptorRevision}`
    : null
  const cacheSeparator = modelCachePath?.includes('\\') ? '\\' : '/'
  const muscriptorCachePath = desktopMuscriptorVerifier && modelCachePath && muscriptorRepository && muscriptorRevision
    ? [
        modelCachePath.replace(/[\\/]+$/, ''),
        `models--${muscriptorRepository.replaceAll('/', '--')}`,
        'snapshots',
        muscriptorRevision,
      ].join(cacheSeparator)
    : null
  const displayedCachePath = muscriptorCachePath || modelCachePath
  const openCacheDirectory = async () => {
    try {
      if (desktopMuscriptorVerifier) await desktopMuscriptorVerifier.openCacheFolder()
      else await desktopModelCache?.open()
    } catch {
      if (desktopMuscriptorVerifier) setMuscriptorVerifyError('Could not open SAVE CACHE UNDER. Check that the VibeSeq Data directory is writable.')
      else setInstallError('Could not open the model cache folder.')
    }
  }
  const showGenericActions = presentation.actions.length > 0
    && !desktopInstaller
    && !(desktopMuscriptorVerifier && capability?.weightsCached === false)
  const displayedGates = desktopInstaller
    ? presentation.gates.filter((gate) => gate.id !== 'access')
    : presentation.gates

  return (
    <section className={`engine-capability-card ${statusClass}`} aria-label={`${title} readiness`}>
      <div className="engine-capability-heading">
        <label>
          <span>{title}</span>
          <select value={selectedProvider} onChange={(event) => onProvider(event.target.value)}>
            {options.map((provider) => <option key={provider} value={provider}>{optionLabel(provider)}</option>)}
          </select>
        </label>
        <span className="engine-state" role="status">
          {presentation.ready ? <CircleCheck /> : <CircleAlert />}
          {presentation.statusLabel}
        </span>
      </div>

      <dl className="engine-provenance">
        <div><dt>MODEL ID</dt><dd>{presentation.modelId}</dd></div>
        <div><dt>WEIGHTS REV</dt><dd>{presentation.modelRevision}</dd></div>
        <div><dt>CODE REV</dt><dd>{presentation.codeRevision}</dd></div>
        <div><dt>RUNTIME</dt><dd>{presentation.runtimeLabel}</dd></div>
      </dl>

      {displayedGates.length > 0 && (
        <ul className="engine-gates" aria-label={`${title} execution gates`}>
          {displayedGates.map((gate) => (
            <li key={gate.id} data-state={gate.state}>
              <span aria-hidden="true" />
              {gate.label}
              <small>{gate.state.toUpperCase()}</small>
            </li>
          ))}
        </ul>
      )}

      <p className="engine-reason">{presentation.reason}</p>

      {showGenericActions && (
        <div className="engine-actions" role="note" aria-label={`${title} required actions`}>
          <b>REQUIRED</b>
          <ul>{presentation.actions.map((action) => <li key={action}>{action}</li>)}</ul>
          {presentation.accessUrl && capability?.weightsCached === false && (
            <a href={presentation.accessUrl} target="_blank" rel="noreferrer" onClick={(event) => openExternal(event, presentation.accessUrl!)}>
              {capability.gated ? 'Open model access page' : 'Open official model files'} <ExternalLink />
            </a>
          )}
          {sourceUrl && capability?.codeCached !== true && (
            <a href={sourceUrl} target="_blank" rel="noreferrer" onClick={(event) => openExternal(event, sourceUrl)}>
              Open exact source revision <ExternalLink />
            </a>
          )}
        </div>
      )}

      {showModelInstallation && capability?.bootstrap && (
        <div className="engine-model-install" role="note" aria-label={`${title} model installation`}>
          <b>{desktopMuscriptorVerifier ? 'VERIFY MODEL FILES' : 'MODEL INSTALL'}</b>
          <dl>
            <div><dt>FROM</dt><dd>{capability.bootstrap.modelId}@{capability.bootstrap.revision}</dd></div>
            <div>
              <dt>SAVE CACHE UNDER</dt>
              <dd>
                {(desktopMuscriptorVerifier || desktopModelCache) && displayedCachePath ? (
                  <button
                    type="button"
                    className="engine-cache-path"
                    title="Open model cache folder"
                    aria-label="Open model cache folder"
                    onClick={() => void openCacheDirectory()}
                  >
                    <span>{displayedCachePath}</span><FolderOpen aria-hidden="true" />
                  </button>
                ) : displayedCachePath || 'Model cache path not reported'}
              </dd>
            </div>
            {installStatus?.variantLabel && <div><dt>THIS OS</dt><dd>{installStatus.variantLabel}</dd></div>}
            {installStatus?.totalBytes ? <div><dt>DOWNLOAD</dt><dd>{formatBytes(installStatus.totalBytes)}</dd></div> : null}
          </dl>
          <span>Required files</span>
          <ul>
            {(capability.bootstrap.files ?? capability.missingFiles ?? []).map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
          {desktopCudaRuntime && muscriptorCudaRuntimeRequired && (
            <div className="engine-model-downloader" aria-label="MuScriptor CUDA runtime installation">
              <b>CUDA RUNTIME</b>
              <p>MuScriptor uses the same managed CUDA PyTorch runtime as Stable Audio. Its model files and cache path do not change.</p>
              {installingCudaRuntime && (
                <div className="engine-download-progress">
                  <progress aria-label="MuScriptor CUDA runtime installation progress" />
                  <small>{cudaRuntimeProgress?.detail || 'Preparing the managed CUDA runtime'}</small>
                </div>
              )}
              {cudaRuntimeError && <p className="engine-install-error" role="alert">{cudaRuntimeError}</p>}
              {installingCudaRuntime ? (
                <button type="button" className="secondary-button" onClick={() => void cancelMuscriptorCudaRuntime()}><Square /> Cancel runtime install</button>
              ) : (
                <button
                  type="button"
                  className="primary-button"
                  disabled={cudaRuntimeStatus?.supported === false}
                  onClick={() => void installMuscriptorCudaRuntime()}
                >
                  <Download /> {cudaRuntimeStatus?.installed ? 'Refresh CUDA readiness' : 'Install CUDA runtime'}
                </button>
              )}
              <small>The managed runtime is installed below VibeSeq Data and does not modify the system Python environment.</small>
            </div>
          )}
          {desktopInstaller && installStatus?.supported && (
            <div className="engine-model-downloader">
              <label className="engine-license-consent">
                <input
                  type="checkbox"
                  checked={termsAccepted}
                  disabled={installing}
                  onChange={(event) => setTermsAccepted(event.target.checked)}
                />
                <span>
                  I agree to the{' '}
                  <a href={installStatus.terms?.stability} target="_blank" rel="noreferrer" onClick={(event) => openExternal(event, installStatus.terms!.stability)}>Stability AI Community License</a>
                  {' '}and{' '}
                  <a href={installStatus.terms?.gemma} target="_blank" rel="noreferrer" onClick={(event) => openExternal(event, installStatus.terms!.gemma)}>Gemma Terms of Use</a>, including their use restrictions.
                </span>
              </label>
              {(installing || installProgress) && (
                <div className="engine-download-progress">
                  <progress
                    max={installProgress?.totalBytes || installStatus.totalBytes}
                    value={installProgress?.phase === 'runtime'
                      ? undefined
                      : installProgress?.downloadedBytes ?? installStatus.installedBytes}
                    aria-label="Stable Audio model download progress"
                  />
                  <small>
                    {installProgress?.phase === 'runtime'
                      ? `CUDA runtime · ${installProgress.asset || 'Installing isolated Python and GPU packages'}`
                      : `${formatBytes(installProgress?.downloadedBytes ?? installStatus.installedBytes)} / ${formatBytes(installStatus.totalBytes)}${installProgress?.asset ? ` · ${installProgress.asset}` : ''}`}
                  </small>
                </div>
              )}
              {installError && <p className="engine-install-error" role="alert">{installError}</p>}
              {installing ? (
                <button type="button" className="secondary-button" onClick={() => void cancelInstallation()}><Square /> Cancel download</button>
              ) : (
                <button
                  type="button"
                  className="primary-button"
                  disabled={!termsAccepted}
                  onClick={() => void startInstallation()}
                >
                  <Download /> Download &amp; install {formatBytes(installStatus.totalBytes)}
                </button>
              )}
              <small>Downloads resume after interruption. Every final model file is digest-verified before activation.</small>
            </div>
          )}
          {desktopMuscriptorVerifier && muscriptorRevisionRoot && (
            <div className="engine-gated-installer">
              <ol>
                <li>
                  Sign in to Hugging Face, open the{' '}
                  <a href={capability.bootstrap?.accessUrl} target="_blank" rel="noreferrer" onClick={(event) => openExternal(event, capability.bootstrap!.accessUrl!)}>MuScriptor access form</a>,
                  {' '}fill in the requested fields, and accept its gated conditions.
                </li>
                <li>
                  From the pinned revision, download{' '}
                  <a href={`${muscriptorRevisionRoot}/config.json`} target="_blank" rel="noreferrer" onClick={(event) => openExternal(event, `${muscriptorRevisionRoot}/config.json`)}>config.json</a>
                  {' '}and{' '}
                  <a href={`${muscriptorRevisionRoot}/model.safetensors`} target="_blank" rel="noreferrer" onClick={(event) => openExternal(event, `${muscriptorRevisionRoot}/model.safetensors`)}>model.safetensors</a>.
                </li>
                <li>Click SAVE CACHE UNDER to open the exact folder, place both downloaded files directly inside it, then verify the cache below.</li>
              </ol>
              {muscriptorVerifyError && <p className="engine-install-error" role="alert">{muscriptorVerifyError}</p>}
              <button type="button" className="primary-button" disabled={verifyingMuscriptor} onClick={() => void verifyMuscriptorFiles()}>
                <FileCheck2 /> {verifyingMuscriptor ? 'Verifying MuScriptor cache…' : 'Verify files in cache'}
              </button>
              <small>VibeSeq does not download, select, or move MuScriptor files and never asks for your Hugging Face token. It only verifies the two files already under SAVE CACHE UNDER. MuScriptor remains subject to CC BY-NC 4.0 and its gated conditions.</small>
            </div>
          )}
          {!desktopInstaller && !desktopMuscriptorVerifier && <small>Keep the Hugging Face repository cache layout intact. Restart VibeSeq after the exact revision is installed.</small>}
        </div>
      )}

      {capability?.license && <p className="engine-license">LICENSE · {capability.license}</p>}
      {kind === 'generation' && selectedProvider === 'stable-audio-3' && <p className="engine-powered-by">Powered by Stability AI</p>}
    </section>
  )
}

export function EngineDialog({
  health,
  generationProvider,
  transcriptionProvider,
  onGenerationProvider,
  onTranscriptionProvider,
  onModelInstalled,
  onClose,
}: EngineDialogProps) {
  const generationOptions = health?.selectableProviders?.generation ?? ['procedural-demo', 'stable-audio-3']
  const transcriptionOptions = health?.selectableProviders?.transcription ?? ['signal-demo', 'muscriptor']
  const dialogRef = useModalFocus<HTMLElement>()
  const serviceHealthy = health?.status === 'ok'
  const devices = health?.hardware.devices?.map((device) => device.toUpperCase()).join(' → ') || 'not reported'
  const selectedGeneration = capabilityFor(health, 'generation', generationProvider)
  const selectedTranscription = capabilityFor(health, 'transcription', transcriptionProvider)
  const cudaCapability = [selectedGeneration, selectedTranscription].find((candidate) => (
    candidate?.device?.toLowerCase() === 'cuda'
    || candidate?.route?.startsWith('cuda-') === true
  ))
  const computeLabel = cudaCapability
    ? 'GPU'
    : health?.hardware.preferredDevice?.toUpperCase() ?? 'NO DEVICE REPORT'
  const cudaRuntimeLabel = cudaCapability?.runtime === 'pytorch-fa2'
    ? 'CUDA · FlashAttention 2'
    : cudaCapability?.runtime === 'pytorch-cuda'
      ? 'CUDA · PyTorch'
      : cudaCapability?.runtime || cudaCapability?.route || 'CUDA'
  const computeDetail = cudaCapability
    ? `${health?.hardware.cudaName || 'NVIDIA CUDA GPU'} · ${cudaRuntimeLabel}`
    : `Target ${health?.target ?? 'unknown'} · route order ${devices}`

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="dialog engine-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="engine-dialog-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onClose() } }}
      >
        <header>
          <div><p className="eyebrow">COMPUTE</p><h2 id="engine-dialog-title">Inference readiness</h2></div>
          <button autoFocus className="icon-button" onClick={onClose} aria-label="Close engine settings"><X /></button>
        </header>

        <div className={`hardware-card ${serviceHealthy ? 'is-healthy' : 'is-offline'}`} role="status">
          <MonitorCog />
          <div>
            <b>{computeLabel}</b>
            <small>{computeDetail}</small>
          </div>
          <span>{serviceHealthy ? 'HEALTH RESPONDED' : 'NO HEALTH RESPONSE'}</span>
        </div>

        <div className="engine-capabilities">
          <EngineCapabilityCard
            title="Audio generation"
            kind="generation"
            health={health}
            selectedProvider={generationProvider}
            options={generationOptions}
            onProvider={onGenerationProvider}
            onModelInstalled={onModelInstalled}
            modelCachePath={health?.storage?.modelCache}
          />
          <EngineCapabilityCard
            title="MIDI extraction"
            kind="transcription"
            health={health}
            selectedProvider={transcriptionProvider}
            options={transcriptionOptions}
            onProvider={onTranscriptionProvider}
            onModelInstalled={onModelInstalled}
            modelCachePath={health?.storage?.modelCache}
          />
        </div>

        <p className="license-note"><Save />Medium is the minimum real-model tier. VibeSeq never substitutes Small or a demo after a real-provider failure; exact provenance is stored with each output.</p>
        <button className="primary-button" onClick={onClose}>Done</button>
      </section>
    </div>
  )
}
