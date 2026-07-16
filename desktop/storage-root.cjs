const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DATA_DIRECTORY_NAME = 'VibeSeq Data'
const STORAGE_DIRECTORIES = Object.freeze([
  'cache',
  'inference',
  'library',
  'logs',
  'models',
  'profile',
  'projects',
  'runtimes',
])

const expandHome = (value, homeDirectory) => {
  if (value === '~') return homeDirectory
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homeDirectory, value.slice(2))
  }
  return value
}

const resolveStorageRoot = ({
  platform = process.platform,
  env = process.env,
  homeDirectory = os.homedir(),
  executablePath = process.execPath,
  isPackaged = false,
} = {}) => {
  const configured = env.VIBESEQ_HOME?.trim()
  if (configured) return path.resolve(expandHome(configured, homeDirectory))

  if (platform === 'win32' && isPackaged) {
    const portableDirectory = env.PORTABLE_EXECUTABLE_DIR?.trim()
    const applicationDirectory = portableDirectory || path.dirname(executablePath)
    return path.join(path.resolve(applicationDirectory), DATA_DIRECTORY_NAME)
  }

  return path.join(homeDirectory, DATA_DIRECTORY_NAME)
}

const prepareStorageRoot = (root) => {
  fs.mkdirSync(root, { recursive: true })
  for (const directory of STORAGE_DIRECTORIES) {
    fs.mkdirSync(path.join(root, directory), { recursive: true })
  }
  return root
}

const configureElectronStorage = (electronApp, root) => {
  prepareStorageRoot(root)
  electronApp.setPath('userData', path.join(root, 'profile'))
  electronApp.setPath('cache', path.join(root, 'cache', 'chromium'))
  electronApp.setPath('logs', path.join(root, 'logs'))
}

const sidecarStorageEnvironment = (root) => {
  const huggingFaceHome = path.join(root, 'models', 'huggingface')
  return {
    VIBESEQ_HOME: root,
    VIBESEQ_DATA_DIR: path.join(root, 'inference'),
    VIBESEQ_RUNTIME_DIR: path.join(root, 'runtimes'),
    HF_HOME: huggingFaceHome,
    HUGGINGFACE_HUB_CACHE: path.join(huggingFaceHome, 'hub'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
  }
}

module.exports = {
  DATA_DIRECTORY_NAME,
  STORAGE_DIRECTORIES,
  configureElectronStorage,
  prepareStorageRoot,
  resolveStorageRoot,
  sidecarStorageEnvironment,
}
