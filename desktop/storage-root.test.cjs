const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  STORAGE_DIRECTORIES,
  prepareStorageRoot,
  prepareStorageRootAsync,
  resolveStorageRoot,
  sidecarStorageEnvironment,
} = require('./storage-root.cjs')

test('Windows portable storage stays beside the distributed executable', () => {
  const root = resolveStorageRoot({
    platform: 'win32',
    env: { PORTABLE_EXECUTABLE_DIR: 'D:\\Music\\VibeSeq' },
    homeDirectory: 'C:\\Users\\artist',
    executablePath: 'C:\\Temp\\electron\\VibeSeq.exe',
    isPackaged: true,
  })
  assert.equal(root, path.join(path.resolve('D:\\Music\\VibeSeq'), 'VibeSeq Data'))
})

test('Windows installed storage stays beside the installed executable', () => {
  const applicationDirectory = path.join(path.parse(process.cwd()).root, 'Program Files', 'VibeSeq')
  const root = resolveStorageRoot({
    platform: 'win32',
    env: {},
    homeDirectory: 'C:\\Users\\artist',
    executablePath: path.join(applicationDirectory, 'VibeSeq.exe'),
    isPackaged: true,
  })
  assert.equal(root, path.join(applicationDirectory, 'VibeSeq Data'))
})

test('macOS storage defaults to VibeSeq Data in the home directory', () => {
  const root = resolveStorageRoot({
    platform: 'darwin',
    env: {},
    homeDirectory: '/Users/artist',
    executablePath: '/Applications/VibeSeq.app/Contents/MacOS/VibeSeq',
    isPackaged: true,
  })
  assert.equal(root, path.join('/Users/artist', 'VibeSeq Data'))
})

test('Linux storage defaults to VibeSeq Data in the home directory', () => {
  const root = resolveStorageRoot({
    platform: 'linux',
    env: {},
    homeDirectory: '/home/artist',
    executablePath: '/tmp/.mount_VibeSeq/VibeSeq',
    isPackaged: true,
  })
  assert.equal(root, path.join('/home/artist', 'VibeSeq Data'))
})

test('VIBESEQ_HOME overrides platform defaults and expands home', () => {
  const homeDirectory = path.join(path.parse(process.cwd()).root, 'Users', 'artist')
  const root = resolveStorageRoot({
    platform: 'darwin',
    env: { VIBESEQ_HOME: '~/Music/VibeSeq' },
    homeDirectory,
    isPackaged: true,
  })
  assert.equal(root, path.join(homeDirectory, 'Music', 'VibeSeq'))
})

test('storage root creates every durable data directory', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeseq-storage-'))
  const root = path.join(temporary, 'VibeSeq Data')
  try {
    prepareStorageRoot(root)
    for (const directory of STORAGE_DIRECTORIES) {
      assert.equal(fs.statSync(path.join(root, directory)).isDirectory(), true)
    }
    const environment = sidecarStorageEnvironment(root)
    assert.equal(environment.VIBESEQ_DATA_DIR, path.join(root, 'inference'))
    assert.equal(environment.VIBESEQ_RUNTIME_DIR, path.join(root, 'runtimes'))
    assert.equal(environment.HF_HOME, path.join(root, 'models', 'huggingface'))
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('asynchronous storage preparation creates every durable data directory', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeseq-storage-async-'))
  const root = path.join(temporary, 'VibeSeq Data')
  try {
    await prepareStorageRootAsync(root)
    for (const directory of STORAGE_DIRECTORIES) {
      assert.equal(fs.statSync(path.join(root, directory)).isDirectory(), true)
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
