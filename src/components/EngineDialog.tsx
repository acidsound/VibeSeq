import { CircleAlert, CircleCheck, ExternalLink, MonitorCog, Save, X } from 'lucide-react'
import type { EngineCapability, InferenceHealth } from '../api/inference'
import { useModalFocus } from '../hooks/useModalFocus'
import { presentEngine } from '../ui/engineHealth'

type EngineDialogProps = {
  health: InferenceHealth | null
  generationProvider: string
  transcriptionProvider: string
  onGenerationProvider: (value: string) => void
  onTranscriptionProvider: (value: string) => void
  onClose: () => void
}

type EngineCapabilityCardProps = {
  title: string
  kind: 'generation' | 'transcription'
  health: InferenceHealth | null
  selectedProvider: string
  options: string[]
  onProvider: (value: string) => void
  modelCachePath?: string
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
  modelCachePath,
}: EngineCapabilityCardProps) {
  const presentation = presentEngine(health, kind, selectedProvider)
  const capability = capabilityFor(health, kind, selectedProvider)
  const sourceUrl = capability ? sourceRevisionUrl(capability) : null
  const statusClass = presentation.ready ? 'is-ready' : presentation.inspected ? 'is-blocked' : 'is-unknown'

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

      {presentation.gates.length > 0 && (
        <ul className="engine-gates" aria-label={`${title} execution gates`}>
          {presentation.gates.map((gate) => (
            <li key={gate.id} data-state={gate.state}>
              <span aria-hidden="true" />
              {gate.label}
              <small>{gate.state.toUpperCase()}</small>
            </li>
          ))}
        </ul>
      )}

      <p className="engine-reason">{presentation.reason}</p>

      {presentation.actions.length > 0 && (
        <div className="engine-actions" role="note" aria-label={`${title} required actions`}>
          <b>REQUIRED</b>
          <ul>{presentation.actions.map((action) => <li key={action}>{action}</li>)}</ul>
          {presentation.accessUrl && capability?.weightsCached === false && (
            <a href={presentation.accessUrl} target="_blank" rel="noreferrer">
              {capability.gated ? 'Open model access page' : 'Open official model files'} <ExternalLink />
            </a>
          )}
          {sourceUrl && capability?.codeCached !== true && (
            <a href={sourceUrl} target="_blank" rel="noreferrer">
              Open exact source revision <ExternalLink />
            </a>
          )}
        </div>
      )}

      {capability?.weightsCached === false && capability.bootstrap && (
        <div className="engine-model-install" role="note" aria-label={`${title} model installation`}>
          <b>MODEL INSTALL</b>
          <dl>
            <div><dt>FROM</dt><dd>{capability.bootstrap.modelId}@{capability.bootstrap.revision}</dd></div>
            <div><dt>SAVE CACHE UNDER</dt><dd>{modelCachePath || 'Model cache path not reported'}</dd></div>
          </dl>
          <span>Required files</span>
          <ul>
            {(capability.bootstrap.files ?? capability.missingFiles ?? []).map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
          <small>Keep the Hugging Face repository cache layout intact. Restart VibeSeq after the exact revision is installed.</small>
        </div>
      )}

      {capability?.license && <p className="engine-license">LICENSE · {capability.license}</p>}
    </section>
  )
}

export function EngineDialog({
  health,
  generationProvider,
  transcriptionProvider,
  onGenerationProvider,
  onTranscriptionProvider,
  onClose,
}: EngineDialogProps) {
  const generationOptions = health?.selectableProviders?.generation ?? ['procedural-demo', 'stable-audio-3']
  const transcriptionOptions = health?.selectableProviders?.transcription ?? ['signal-demo', 'muscriptor']
  const dialogRef = useModalFocus<HTMLElement>()
  const serviceHealthy = health?.status === 'ok'
  const devices = health?.hardware.devices?.map((device) => device.toUpperCase()).join(' → ') || 'not reported'

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
            <b>{health?.hardware.preferredDevice?.toUpperCase() ?? 'NO DEVICE REPORT'}</b>
            <small>Target {health?.target ?? 'unknown'} · route order {devices}</small>
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
            modelCachePath={health?.storage?.modelCache}
          />
          <EngineCapabilityCard
            title="MIDI extraction"
            kind="transcription"
            health={health}
            selectedProvider={transcriptionProvider}
            options={transcriptionOptions}
            onProvider={onTranscriptionProvider}
            modelCachePath={health?.storage?.modelCache}
          />
        </div>

        <p className="license-note"><Save />Medium is the minimum real-model tier. VibeSeq never substitutes Small or a demo after a real-provider failure; exact provenance is stored with each output.</p>
        <button className="primary-button" onClick={onClose}>Done</button>
      </section>
    </div>
  )
}
