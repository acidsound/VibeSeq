import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDirectory, '..')
const defaultManifestPath = path.join(repositoryRoot, 'desktop', 'stable-audio-gpu-model-bundle.json')
const defaultNoticePath = path.join(repositoryRoot, 'desktop', 'stable-audio-NOTICE.txt')

const digestFor = (descriptor) => {
  const expected = descriptor.sha256 || descriptor.gitSha1
  const algorithm = descriptor.gitSha1 ? 'sha1' : 'sha256'
  const hash = crypto.createHash(algorithm)
  if (descriptor.gitSha1) hash.update(`blob ${descriptor.size}\0`)
  return { expected, hash }
}

const encodedModelPath = (value) => value.split('/').map(encodeURIComponent).join('/')

const downloadToReleaseParts = async ({
  descriptor,
  modelId,
  revision,
  outputDirectory,
  token,
  fetchImpl,
}) => {
  const url = `https://huggingface.co/${modelId}/resolve/${revision}/${encodedModelPath(descriptor.destination)}`
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'follow',
  })
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${descriptor.destination}: HTTP ${response.status}`)
  }

  const fullDigest = digestFor(descriptor)
  let fullSize = 0
  let partIndex = 0
  let partSize = 0
  let partHandle = null
  let partDigest = null

  const openPart = async () => {
    const part = descriptor.parts[partIndex]
    partHandle = await fs.open(path.join(outputDirectory, part.asset), 'wx')
    partDigest = digestFor(part)
    partSize = 0
  }
  const closePart = async () => {
    const part = descriptor.parts[partIndex]
    await partHandle.close()
    partHandle = null
    if (partSize !== part.size) {
      throw new Error(`Downloaded size mismatch for ${part.asset}.`)
    }
    if (partDigest.expected && partDigest.hash.digest('hex') !== partDigest.expected) {
      throw new Error(`Digest mismatch for ${part.asset}.`)
    }
    partIndex += 1
  }

  try {
    await openPart()
    for await (const value of response.body) {
      let chunk = Buffer.from(value)
      fullDigest.hash.update(chunk)
      fullSize += chunk.length
      while (chunk.length > 0) {
        const part = descriptor.parts[partIndex]
        const writable = Math.min(chunk.length, part.size - partSize)
        const slice = chunk.subarray(0, writable)
        await partHandle.write(slice)
        partDigest.hash.update(slice)
        partSize += writable
        chunk = chunk.subarray(writable)
        if (partSize === part.size) {
          await closePart()
          if (partIndex < descriptor.parts.length) await openPart()
        }
      }
    }
    if (partHandle) await closePart()
  } finally {
    await partHandle?.close().catch(() => undefined)
  }

  if (partIndex !== descriptor.parts.length || fullSize !== descriptor.size) {
    throw new Error(`Downloaded size mismatch for ${descriptor.destination}.`)
  }
  if (fullDigest.hash.digest('hex') !== fullDigest.expected) {
    throw new Error(`Final digest mismatch for ${descriptor.destination}.`)
  }
}

export const prepareGpuReleaseBundle = async ({
  manifest,
  outputDirectory,
  token,
  fetchImpl = globalThis.fetch,
  manifestPath = defaultManifestPath,
  noticePath = defaultNoticePath,
}) => {
  if (!String(token || '').trim()) throw new Error('HF_TOKEN is required to prepare the gated source bundle.')
  if (typeof fetchImpl !== 'function') throw new Error('This Node.js runtime does not provide fetch().')
  const variant = manifest.variants?.['win32-x64']
  if (!variant?.release?.tag) throw new Error('The Windows GPU release variant is missing.')
  await fs.mkdir(outputDirectory, { recursive: true })
  const existing = await fs.readdir(outputDirectory)
  if (existing.length > 0) throw new Error('The GPU release output directory must be empty.')

  for (const descriptor of [...(manifest.commonFiles || []), ...variant.files]) {
    await downloadToReleaseParts({
      descriptor,
      modelId: manifest.modelId,
      revision: manifest.revision,
      outputDirectory,
      token: String(token).trim(),
      fetchImpl,
    })
  }

  if (manifestPath) {
    await fs.copyFile(manifestPath, path.join(outputDirectory, 'stable-audio-gpu-model-bundle.json'))
  }
  if (noticePath) {
    await fs.copyFile(noticePath, path.join(outputDirectory, 'VibeSeq-NOTICE.txt'))
  }
  return { tag: variant.release.tag, outputDirectory }
}

const argumentValue = (name) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const manifestPath = argumentValue('--manifest') || defaultManifestPath
  const outputDirectory = argumentValue('--output')
  if (!outputDirectory) throw new Error('Usage: node scripts/prepare-stable-audio-gpu-release.mjs --output <empty-directory>')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  const result = await prepareGpuReleaseBundle({
    manifest,
    outputDirectory: path.resolve(outputDirectory),
    token: process.env.HF_TOKEN,
    manifestPath,
  })
  process.stdout.write(`Prepared ${result.tag} release assets.\n`)
}
