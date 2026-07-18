import type { EngineCapability, InferenceHealth } from '../api/inference'

export type EngineGate = {
  id: 'model' | 'code' | 'package' | 'weights' | 'access' | 'runtime' | 'adapter' | 'execution'
  label: string
  state: 'pass' | 'blocked' | 'unknown'
}

export type EnginePresentation = {
  provider: string
  inspected: boolean
  ready: boolean
  fixture: boolean
  statusLabel: string
  modelId: string
  modelRevision: string
  codeRevision: string
  runtimeLabel: string
  reason: string
  actions: string[]
  accessUrl?: string
  gates: EngineGate[]
}

const providerName = (provider: string): string => {
  if (provider === 'stable-audio-3') return 'Stable Audio 3'
  if (provider === 'muscriptor') return 'MuScriptor'
  if (provider === 'procedural-demo') return 'Procedural demo'
  if (provider === 'signal-demo') return 'Signal demo'
  return provider
}

const gateState = (value: boolean | null | undefined): EngineGate['state'] => {
  if (value === true) return 'pass'
  if (value === false) return 'blocked'
  return 'unknown'
}

const revision = (capability: EngineCapability, key: 'model' | 'code'): string => {
  const value = key === 'model'
    ? capability.modelRevision ?? capability.revision
    : capability.codeRevision
  return value || 'not reported'
}

const runtimeLabel = (capability: EngineCapability): string => {
  const runtime = capability.runtime || 'runtime not reported'
  const device = capability.device || 'device not reported'
  return [runtime, device, capability.route].filter(Boolean).join(' · ')
}

const requiresMedium = (provider: string): boolean =>
  provider === 'stable-audio-3' || provider === 'muscriptor'

const isMediumOrAbove = (capability: EngineCapability): boolean => {
  const identity = `${capability.model} ${capability.modelId ?? ''}`.toLowerCase()
  return /(^|[-_/\s])(medium|large|xl)([-_/\s]|$)/.test(identity)
}

const blockingActions = (capability: EngineCapability): string[] => {
  const actions: string[] = []
  if (requiresMedium(capability.provider) && !isMediumOrAbove(capability)) {
    actions.push(`The service reported ${capability.modelId || capability.model}; configure the Medium model or above. VibeSeq never downgrades to Small.`)
  }
  if (requiresMedium(capability.provider) && capability.codeCached !== true) {
    const source = capability.codeRepository || 'the reported source repository'
    actions.push(`Cache the exact source checkout from ${source}@${revision(capability, 'code')}; model readiness requires verified code as well as weights.`)
  }
  if (capability.gated && capability.accessGranted !== true) {
    actions.push(`Approve gated access for ${capability.modelId || capability.model}, then cache this exact revision.`)
  }
  if (capability.packageInstalled === false) {
    const packages = (capability.missingPackages?.length
      ? capability.missingPackages
      : capability.requiredPackages)?.join(', ') || 'the reported runtime packages'
    actions.push(`Install required runtime packages: ${packages}.`)
  }
  if (capability.weightsCached === false) {
    const files = capability.missingFiles?.length
      ? `${capability.missingFiles.length} missing file${capability.missingFiles.length === 1 ? '' : 's'}`
      : 'the required files'
    actions.push(`Cache ${files} from ${capability.modelId || capability.model}@${revision(capability, 'model')}.`)
  }
  if (capability.runtimeCompatible === false) {
    actions.push('Run this provider on hardware supported by the reported runtime route.')
  }
  if (capability.adapterImplemented === false) {
    actions.push(`The ${capability.route || capability.runtime || 'selected'} adapter is not executable in this build; use a verified route.`)
  }
  if (capability.executionEnabled === false) {
    actions.push(capability.provisional
      ? 'This provisional route is disabled until its explicit runtime gate is enabled after verification.'
      : 'Execution is disabled for this runtime route in the current service build.')
  }
  if (capability.ready === undefined) {
    actions.push('Restart or update the inference service so it reports explicit readiness; VibeSeq does not infer readiness from availability alone.')
  }
  if (actions.length === 0 && capability.ready !== true) {
    const hasExplicitGates = [
      capability.packageInstalled,
      capability.weightsCached,
      capability.codeCached,
      capability.accessGranted,
      capability.runtimeCompatible,
      capability.adapterImplemented,
      capability.executionEnabled,
    ].some((value) => value !== undefined)
    actions.push(hasExplicitGates
      ? capability.reason || 'Inspect the inference service health response for the remaining blocked gate.'
      : 'The service did not report enough execution gates to establish readiness.')
  }
  return actions
}

export const presentEngine = (
  health: InferenceHealth | null,
  kind: 'generation' | 'transcription',
  selectedProvider: string,
): EnginePresentation => {
  const capability = health?.[kind]
  const inspected = Boolean(capability && capability.provider === selectedProvider)

  if (!health || !capability) {
    return {
      provider: selectedProvider,
      inspected: false,
      ready: false,
      fixture: selectedProvider.endsWith('-demo'),
      statusLabel: 'NO HEALTH DATA',
      modelId: 'not reported',
      modelRevision: 'not reported',
      codeRevision: 'not reported',
      runtimeLabel: 'runtime not reported',
      reason: 'The inference service did not return a health response.',
      actions: ['Start the inference service, then reopen this panel to verify the selected provider.'],
      gates: [],
    }
  }

  if (!inspected) {
    return {
      provider: selectedProvider,
      inspected: false,
      ready: false,
      fixture: selectedProvider.endsWith('-demo'),
      statusLabel: 'NOT INSPECTED',
      modelId: 'not reported for selection',
      modelRevision: 'not reported',
      codeRevision: 'not reported',
      runtimeLabel: 'runtime not reported for selection',
      reason: `Health currently describes ${providerName(capability.provider)}, not ${providerName(selectedProvider)}.`,
      actions: [`Select ${capability.provider} for the verified state, or configure the service default to ${selectedProvider} and reopen this panel.`],
      gates: [],
    }
  }

  const modelEligible = !requiresMedium(selectedProvider) || isMediumOrAbove(capability)
  const codeEligible = !requiresMedium(selectedProvider) || capability.codeCached === true
  const ready = capability.ready === true && modelEligible && codeEligible
  const fixture = capability.runtime === 'vibeseq-fixture' || selectedProvider.endsWith('-demo')
  const accessState = capability.gated
    ? gateState(capability.accessGranted)
    : capability.accessGranted === undefined
      ? 'unknown'
      : gateState(capability.accessGranted)
  const reason = !modelEligible
    ? 'The reported model is below VibeSeq’s Medium minimum and is not eligible for real inference.'
    : !codeEligible
      ? 'The exact source revision is not cached, so this Medium route is not reproducibly ready.'
      : capability.reason || (ready ? 'All reported execution gates passed.' : 'The provider is not ready.')

  return {
    provider: selectedProvider,
    inspected: true,
    ready,
    fixture,
    statusLabel: ready ? (fixture ? 'FIXTURE READY' : 'MEDIUM READY') : 'BLOCKED',
    modelId: capability.modelId || capability.model || 'not reported',
    modelRevision: revision(capability, 'model'),
    codeRevision: revision(capability, 'code'),
    runtimeLabel: runtimeLabel(capability),
    reason,
    actions: ready ? [] : blockingActions(capability),
    accessUrl: capability.bootstrap?.accessUrl,
    gates: [
      { id: 'model', label: 'MODEL', state: modelEligible ? 'pass' : 'blocked' },
      { id: 'code', label: 'CODE', state: codeEligible ? 'pass' : 'blocked' },
      { id: 'package', label: 'PKG', state: gateState(capability.packageInstalled) },
      { id: 'weights', label: 'WEIGHTS', state: gateState(capability.weightsCached) },
      { id: 'access', label: 'ACCESS', state: accessState },
      { id: 'runtime', label: 'RUNTIME', state: gateState(capability.runtimeCompatible) },
      { id: 'adapter', label: 'ADAPTER', state: gateState(capability.adapterImplemented) },
      { id: 'execution', label: 'EXEC', state: gateState(capability.executionEnabled) },
    ],
  }
}

export const presentTransportEngine = (
  health: InferenceHealth | null,
  selectedProvider: string,
): { ready: boolean; label: string; title: string } => {
  const presentation = presentEngine(health, 'generation', selectedProvider)
  const capability = health?.generation
  if (!presentation.inspected || !capability) {
    return {
      ready: false,
      label: `${providerName(selectedProvider)} · ${health ? 'not inspected' : 'no health'}`,
      title: `${presentation.statusLabel}. ${presentation.reason} ${presentation.actions[0] ?? ''}`.trim(),
    }
  }

  const model = presentation.fixture
    ? providerName(selectedProvider)
    : capability.model === 'medium'
      ? `${providerName(selectedProvider)} Medium`
      : capability.model || providerName(selectedProvider)
  const runtime = capability.runtime || capability.device || 'runtime unknown'
  return {
    ready: presentation.ready,
    label: `${model} · ${presentation.ready ? runtime : 'blocked'}`,
    title: `${presentation.statusLabel} · ${presentation.modelId}@${presentation.modelRevision} · ${presentation.runtimeLabel}. ${presentation.reason}`,
  }
}
