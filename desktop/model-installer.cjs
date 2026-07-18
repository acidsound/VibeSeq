const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const MARKER_FILENAME = '.vibeseq-stable-audio-install.json'

const platformKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`

const variantFiles = (manifest, variant) => [
  ...(manifest.commonFiles || []),
  ...variant.files,
]

const snapshotDirectory = (storageRoot, manifest) => path.join(
  storageRoot,
  'models',
  'huggingface',
  'hub',
  `models--${manifest.modelId.replace('/', '--')}`,
  'snapshots',
  manifest.revision,
)

const safeDestination = (root, destination) => {
  const normalized = path.normalize(destination)
  if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Unsafe model destination: ${destination}`)
  }
  const resolved = path.resolve(root, normalized)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe model destination: ${destination}`)
  }
  return resolved
}

const statSize = async (filename) => {
  try {
    return (await fsp.stat(filename)).size
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
}

const digestFile = async (filename, descriptor, { start, end } = {}) => {
  const algorithm = descriptor.gitSha1 ? 'sha1' : 'sha256'
  const hash = crypto.createHash(algorithm)
  if (descriptor.gitSha1) hash.update(`blob ${descriptor.size}\0`)
  const stream = fs.createReadStream(filename, {
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
  })
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

const exactFile = async (filename, file) => (
  await statSize(filename) === file.size
  && await digestFile(filename, file) === (file.sha256 || file.gitSha1)
)

const availableBytes = async (root) => {
  if (typeof fsp.statfs !== 'function') return null
  const stats = await fsp.statfs(root)
  return Number(BigInt(stats.bavail) * BigInt(stats.bsize))
}

const validateVariant = (manifest, variant) => {
  const files = variantFiles(manifest, variant)
  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (total !== variant.downloadBytes) throw new Error(`Invalid model bundle byte total for ${variant.label}.`)
  for (const file of files) {
    const partTotal = file.parts.reduce((sum, part) => sum + part.size, 0)
    if (partTotal !== file.size) throw new Error(`Invalid model part total for ${file.destination}.`)
    if (!/^[a-f0-9]{64}$/.test(file.sha256 || '') && !/^[a-f0-9]{40}$/.test(file.gitSha1 || '')) {
      throw new Error(`Invalid model digest for ${file.destination}.`)
    }
    for (const part of file.parts) {
      if (part.size >= 2 * 1024 * 1024 * 1024) {
        throw new Error(`Release asset exceeds 2 GiB: ${part.asset}.`)
      }
      if (
        (part.sha256 || part.gitSha1)
        && !/^[a-f0-9]{64}$/.test(part.sha256 || '')
        && !/^[a-f0-9]{40}$/.test(part.gitSha1 || '')
      ) {
        throw new Error(`Invalid asset digest for ${part.asset}.`)
      }
    }
  }
}

const encodedAssetPath = (asset) => asset.split('/').map(encodeURIComponent).join('/')

class StableAudioModelInstaller {
  constructor({
    storageRoot,
    manifest,
    platform = process.platform,
    arch = process.arch,
    fetchImpl = globalThis.fetch,
    releaseBaseUrl,
  }) {
    this.storageRoot = storageRoot
    this.manifest = manifest
    this.key = platformKey(platform, arch)
    this.variant = manifest.variants[this.key] || null
    this.fetch = fetchImpl
    this.releaseBaseUrl = (
      releaseBaseUrl
      || this.variant?.release?.baseUrl
      || ''
    ).replace(/\/$/, '')
    if (this.variant) validateVariant(manifest, this.variant)
  }

  async status() {
    if (!this.variant) {
      return {
        supported: false,
        platformKey: this.key,
        installed: false,
        installedBytes: 0,
        totalBytes: 0,
        revision: this.manifest.revision,
      }
    }
    const root = snapshotDirectory(this.storageRoot, this.manifest)
    const files = variantFiles(this.manifest, this.variant)
    let installedBytes = 0
    let installed = true
    for (const file of files) {
      const target = safeDestination(root, file.destination)
      const completeSize = await statSize(target)
      if (completeSize === file.size) {
        installedBytes += file.size
        continue
      }
      installed = false
      const partialSize = await statSize(`${target}.vibeseq-download`)
      installedBytes += Math.min(partialSize, file.size)
    }
    return {
      supported: true,
      platformKey: this.key,
      variantLabel: this.variant.label,
      installed,
      installedBytes,
      totalBytes: this.variant.downloadBytes,
      minimumFreeBytes: this.variant.minimumFreeBytes,
      revision: this.manifest.revision,
      modelId: this.manifest.modelId,
      releaseUrl: `https://github.com/${this.manifest.release.repository}/releases/tag/${this.variant.release.tag}`,
      terms: this.manifest.terms,
      installRoot: root,
    }
  }

  async install({ accepted, signal, onProgress = () => {} }) {
    if (!this.variant) throw new Error(`Stable Audio is not packaged for ${this.key}.`)
    if (accepted !== true) throw new Error('The Stable Audio and Gemma terms must be accepted before installation.')

    const root = snapshotDirectory(this.storageRoot, this.manifest)
    const files = variantFiles(this.manifest, this.variant)
    await fsp.mkdir(root, { recursive: true })
    const before = await this.status()
    if (!before.installed && typeof this.fetch !== 'function') {
      throw new Error('This runtime cannot download model assets.')
    }
    const remainingBytes = Math.max(0, this.variant.downloadBytes - before.installedBytes)
    const safetyBytes = Math.max(0, this.variant.minimumFreeBytes - this.variant.downloadBytes)
    const requiredBytes = remainingBytes + safetyBytes
    const freeBytes = await availableBytes(this.storageRoot)
    if (freeBytes !== null && freeBytes < requiredBytes) {
      throw new Error(
        `Stable Audio needs ${requiredBytes} free bytes to finish, but only ${freeBytes} are available.`,
      )
    }
    let completedBytes = 0
    let lastProgressAt = 0
    const emit = (phase, asset, extraBytes = 0, force = false) => {
      const now = Date.now()
      if (!force && now - lastProgressAt < 100) return
      lastProgressAt = now
      onProgress({
        phase,
        asset,
        downloadedBytes: Math.min(completedBytes + extraBytes, this.variant.downloadBytes),
        totalBytes: this.variant.downloadBytes,
      })
    }

    for (const file of files) {
      if (signal?.aborted) throw new DOMException('Installation cancelled.', 'AbortError')
      const target = safeDestination(root, file.destination)
      await fsp.mkdir(path.dirname(target), { recursive: true })
      if (await statSize(target) === file.size && await exactFile(target, file)) {
        completedBytes += file.size
        emit('verified', file.destination, 0, true)
        continue
      }
      await this.#downloadFile(file, target, signal, (fileBytes, asset) => {
        emit('downloading', asset, fileBytes)
      })
      completedBytes += file.size
      emit('verified', file.destination, 0, true)
    }

    const marker = {
      schemaVersion: 1,
      bundleId: this.manifest.bundleId,
      modelId: this.manifest.modelId,
      revision: this.manifest.revision,
      platform: this.key,
      acceptedAt: new Date().toISOString(),
      notice: 'Powered by Stability AI',
    }
    const markerPath = path.join(root, MARKER_FILENAME)
    const temporaryMarker = `${markerPath}.tmp`
    await fsp.writeFile(temporaryMarker, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
    await fsp.rename(temporaryMarker, markerPath)
    emit('complete', null, 0, true)
    return this.status()
  }

  async #downloadFile(file, target, signal, onBytes) {
    const partial = `${target}.vibeseq-download`
    let currentSize = Math.min(await statSize(partial), file.size)
    if (await statSize(partial) > file.size) {
      await fsp.truncate(partial, 0)
      currentSize = 0
    }

    let partBase = 0
    for (const part of file.parts) {
      const partEnd = partBase + part.size
      if (currentSize >= partEnd) {
        const expectedDigest = part.sha256 || part.gitSha1
        const digest = expectedDigest
          ? await digestFile(partial, part, { start: partBase, end: partEnd - 1 })
          : null
        if (expectedDigest && digest !== expectedDigest) {
          await fsp.truncate(partial, partBase)
          currentSize = partBase
        } else {
          onBytes(currentSize, part.asset)
          partBase = partEnd
          continue
        }
      }

      const offset = Math.max(0, currentSize - partBase)
      // A repository that has just changed from private to public can retain a
      // negative edge-cache entry for the bare release URL. The immutable
      // bundle id makes this URL cache-safe without weakening revision pins.
      const url = `${this.releaseBaseUrl}/${encodedAssetPath(part.asset)}?bundle=${encodeURIComponent(this.manifest.bundleId)}`
      const response = await this.fetch(url, {
        headers: {
          ...(offset > 0 ? { Range: `bytes=${offset}-` } : {}),
        },
        redirect: 'follow',
        signal,
      })
      if (!response.ok || !response.body) {
        throw new Error(`Could not download ${part.asset}: HTTP ${response.status}`)
      }

      let appendAt = currentSize
      if (offset > 0 && response.status !== 206) {
        await fsp.truncate(partial, partBase)
        appendAt = partBase
      } else if (offset === 0) {
        await fsp.mkdir(path.dirname(partial), { recursive: true })
        try {
          await fsp.truncate(partial, partBase)
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
        appendAt = partBase
      }

      const output = fs.createWriteStream(partial, { flags: 'a' })
      const input = Readable.fromWeb(response.body)
      let receivedBytes = 0
      input.on('data', (chunk) => {
        receivedBytes += chunk.length
        onBytes(appendAt + receivedBytes)
      })
      await pipeline(input, output, { signal })
      currentSize = await statSize(partial)
      if (currentSize !== partEnd) {
        throw new Error(`Downloaded size mismatch for ${part.asset}.`)
      }
      const expectedDigest = part.sha256 || part.gitSha1
      const digest = expectedDigest
        ? await digestFile(partial, part, { start: partBase, end: partEnd - 1 })
        : null
      if (expectedDigest && digest !== expectedDigest) {
        await fsp.truncate(partial, partBase)
        throw new Error(`Digest mismatch for ${part.asset}.`)
      }
      partBase = partEnd
    }

    if (
      await statSize(partial) !== file.size
      || await digestFile(partial, file) !== (file.sha256 || file.gitSha1)
    ) {
      await fsp.truncate(partial, 0)
      throw new Error(`Final digest mismatch for ${file.destination}.`)
    }
    try {
      await fsp.unlink(target)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await fsp.rename(partial, target)
  }
}

module.exports = {
  MARKER_FILENAME,
  StableAudioModelInstaller,
  platformKey,
  snapshotDirectory,
}
