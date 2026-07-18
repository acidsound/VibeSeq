const runDesktopStartup = async ({
  createWindow,
  prepareStorage,
  launchSidecar,
  loadStudio,
  updateStartup,
}) => {
  await createWindow()

  updateStartup({
    phase: 'storage',
    step: 1,
    title: 'Preparing local data',
    detail: 'Creating the folders VibeSeq uses for projects, models, and audio.',
    elapsedSeconds: 0,
  })
  await prepareStorage()

  const origin = await launchSidecar(updateStartup)

  updateStartup({
    phase: 'studio',
    step: 4,
    title: 'Opening Studio',
    detail: 'The local engine is ready. Loading your workspace now.',
  })
  await loadStudio(origin, updateStartup)
  return origin
}

module.exports = { runDesktopStartup }
