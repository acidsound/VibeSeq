const fs = require('node:fs/promises')
const path = require('node:path')

const MAX_SAFETENSORS_HEADER_BYTES = 64 * 1024 * 1024

const platformKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`

const verificationFiles = (manifest, platform = process.platform, arch = process.arch) => {
  if (Array.isArray(manifest.files)) return manifest.files
  const variant = manifest.variants?.[platformKey(platform, arch)]
  if (!variant) return []
  return variant.files
    .filter((file) => file.kind)
    .map((file) => ({ ...file, name: file.destination }))
}

const snapshotDirectory = (storageRoot, manifest) => path.join(
  storageRoot,
  'models',
  'huggingface',
  'hub',
  `models--${manifest.modelId.replace('/', '--')}`,
  'snapshots',
  manifest.revision,
)

const validateConfig = async (filename, expected) => {
  const stat = await fs.stat(filename)
  if (stat.size !== expected.size) {
    throw new Error(`${expected.name} must be exactly ${expected.size} bytes.`)
  }
  let config
  try {
    config = JSON.parse(await fs.readFile(filename, 'utf8'))
  } catch {
    throw new Error(`${expected.name} is not valid JSON.`)
  }
  if (config?.model_type !== expected.modelType) {
    throw new Error(`${expected.name} is not a MuScriptor model config.`)
  }
}

const tensorParameterCount = (shape) => {
  if (!Array.isArray(shape) || shape.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('The model contains an invalid tensor shape.')
  }
  return shape.reduce((product, value) => product * value, 1)
}

const validateSafetensors = async (filename, expected) => {
  const handle = await fs.open(filename, 'r')
  try {
    const stat = await handle.stat()
    if (stat.size !== expected.size) {
      throw new Error(`${expected.name} must be exactly ${expected.size} bytes.`)
    }
    const lengthBuffer = Buffer.alloc(8)
    if ((await handle.read(lengthBuffer, 0, 8, 0)).bytesRead !== 8) {
      throw new Error(`${expected.name} has no safetensors header.`)
    }
    const headerLength = Number(lengthBuffer.readBigUInt64LE())
    if (!Number.isSafeInteger(headerLength) || headerLength <= 0 || headerLength > MAX_SAFETENSORS_HEADER_BYTES) {
      throw new Error(`${expected.name} has an invalid safetensors header length.`)
    }
    const headerBuffer = Buffer.alloc(headerLength)
    if ((await handle.read(headerBuffer, 0, headerLength, 8)).bytesRead !== headerLength) {
      throw new Error(`${expected.name} has a truncated safetensors header.`)
    }
    let header
    try {
      header = JSON.parse(headerBuffer.toString('utf8').trim())
    } catch {
      throw new Error(`${expected.name} has an invalid safetensors header.`)
    }
    const tensors = Object.entries(header).filter(([name]) => name !== '__metadata__')
    let parameters = 0
    let maximumDataEnd = 0
    for (const [, tensor] of tensors) {
      if (tensor?.dtype !== expected.dtype) {
        throw new Error(`${expected.name} contains an unexpected tensor type.`)
      }
      const offsets = tensor.data_offsets
      if (!Array.isArray(offsets) || offsets.length !== 2 || offsets.some((value) => !Number.isSafeInteger(value) || value < 0) || offsets[1] < offsets[0]) {
        throw new Error(`${expected.name} contains invalid tensor offsets.`)
      }
      parameters += tensorParameterCount(tensor.shape)
      maximumDataEnd = Math.max(maximumDataEnd, offsets[1])
    }
    if (parameters !== expected.parameterCount) {
      throw new Error(`${expected.name} contains ${parameters} parameters; expected ${expected.parameterCount}.`)
    }
    if (8 + headerLength + maximumDataEnd !== stat.size) {
      throw new Error(`${expected.name} has an invalid data length.`)
    }
  } finally {
    await handle.close()
  }
}

const validateFile = async (filename, expected) => {
  if (expected.kind === 'config') return validateConfig(filename, expected)
  if (expected.kind === 'safetensors') return validateSafetensors(filename, expected)
  throw new Error(`Unsupported MuScriptor file kind: ${expected.kind}.`)
}

class MuscriptorCacheVerifier {
  constructor({ storageRoot, manifest, platform = process.platform, arch = process.arch }) {
    this.storageRoot = storageRoot
    this.manifest = manifest
    this.files = verificationFiles(manifest, platform, arch)
  }

  cacheDirectory() {
    return snapshotDirectory(this.storageRoot, this.manifest)
  }

  async ensureCacheDirectory() {
    const root = this.cacheDirectory()
    await fs.mkdir(root, { recursive: true })
    return root
  }

  async verify() {
    const root = this.cacheDirectory()
    if (this.files.length === 0) throw new Error('MuScriptor is not packaged for this platform.')
    for (const expected of this.files) {
      try {
        await validateFile(path.join(root, expected.name), expected)
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw new Error(`Missing ${expected.name} in the MuScriptor cache folder. Run the one-click MuScriptor model installation again.`)
        }
        throw error
      }
    }
    return {
      verified: true,
      modelId: this.manifest.modelId,
      revision: this.manifest.revision,
      cacheDirectory: root,
      files: this.files.map((file) => file.name),
    }
  }
}

module.exports = {
  MuscriptorCacheVerifier,
  snapshotDirectory,
  validateConfig,
  validateSafetensors,
  verificationFiles,
}
