const assert = require('node:assert/strict')
const test = require('node:test')

const { runDesktopStartup } = require('./startup-flow.cjs')

test('shows the startup window before storage and sidecar work begins', async () => {
  const operations = []
  const progress = []

  const origin = await runDesktopStartup({
    createWindow: async () => { operations.push('window') },
    prepareStorage: async () => { operations.push('storage') },
    launchSidecar: async (updateStartup) => {
      operations.push('sidecar')
      updateStartup({ phase: 'health', step: 3 })
      return 'http://127.0.0.1:10000'
    },
    loadStudio: async (studioOrigin, updateStartup) => {
      operations.push(`studio:${studioOrigin}`)
      updateStartup({ phase: 'studio-ready', step: 4 })
    },
    updateStartup: (state) => { progress.push(state) },
  })

  assert.equal(origin, 'http://127.0.0.1:10000')
  assert.deepEqual(operations, [
    'window',
    'storage',
    'sidecar',
    'studio:http://127.0.0.1:10000',
  ])
  assert.deepEqual(progress.map(({ phase }) => phase), ['storage', 'health', 'studio', 'studio-ready'])
})

test('does not launch the sidecar until asynchronous storage preparation finishes', async () => {
  const operations = []
  let finishStorage
  const storageReady = new Promise((resolve) => { finishStorage = resolve })

  const startup = runDesktopStartup({
    createWindow: async () => { operations.push('window') },
    prepareStorage: async () => {
      operations.push('storage-start')
      await storageReady
      operations.push('storage-finish')
    },
    launchSidecar: async () => {
      operations.push('sidecar')
      return 'http://127.0.0.1:10000'
    },
    loadStudio: async () => { operations.push('studio') },
    updateStartup: () => {},
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(operations, ['window', 'storage-start'])

  finishStorage()
  await startup
  assert.deepEqual(operations, ['window', 'storage-start', 'storage-finish', 'sidecar', 'studio'])
})
