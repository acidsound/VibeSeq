const statusElement = document.querySelector('#startup-status')
const detailElement = document.querySelector('#startup-detail')
const elapsedElement = document.querySelector('#startup-elapsed')
const progressElement = document.querySelector('#startup-progress')
const progressFill = document.querySelector('#startup-progress-fill')
const steps = [...document.querySelectorAll('[data-step]')]

const progressWidth = (step) => {
  if (step <= 0) return 4
  return [20, 44, 72, 92][Math.min(step, 4) - 1]
}

const render = (state) => {
  const step = Number.isFinite(state?.step) ? Math.max(0, Math.min(4, state.step)) : 0
  const failed = state?.phase === 'error'

  document.body.classList.toggle('is-error', failed)
  statusElement.textContent = state?.title || 'Starting VibeSeq'
  detailElement.textContent = state?.detail || 'Preparing the local Studio.'
  elapsedElement.textContent = Number.isFinite(state?.elapsedSeconds) && state.elapsedSeconds > 0
    ? `${state.elapsedSeconds}s elapsed`
    : ''
  progressElement.setAttribute('aria-valuenow', String(step))
  progressFill.style.width = `${failed ? Math.max(8, progressWidth(step)) : progressWidth(step)}%`

  for (const item of steps) {
    const itemStep = Number(item.dataset.step)
    item.classList.toggle('is-active', !failed && itemStep === step)
    item.classList.toggle('is-complete', itemStep < step)
  }
}

const startup = window.vibeseqDesktop?.startup
if (!startup) {
  render({
    phase: 'error',
    step: 0,
    title: 'Startup bridge unavailable',
    detail: 'Restart VibeSeq. If this continues, reinstall the desktop application.',
  })
} else {
  startup.onProgress(render)
  startup.status().then(render).catch((error) => {
    render({
      phase: 'error',
      step: 0,
      title: 'Could not read startup status',
      detail: error instanceof Error ? error.message : String(error),
    })
  })
}
