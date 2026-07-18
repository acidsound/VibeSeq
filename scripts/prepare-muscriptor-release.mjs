import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDirectory, '..')
const defaultManifestPath = path.join(repositoryRoot, 'desktop', 'muscriptor-model-bundle.json')
const defaultNoticePath = path.join(repositoryRoot, 'desktop', 'muscriptor-NOTICE.txt')

const sha256File = async (filename) => {
  const value = await fs.readFile(filename)
  return crypto.createHash('sha256').update(value).digest('hex')
}

const encodedModelPath = (value) => value.split('/').map(encodeURIComponent).join('/')

const downloadAsset = async ({ descriptor, manifest, outputDirectory, token, fetchImpl }) => {
  if (descriptor.parts.length !== 1 || descriptor.parts[0].size !== descriptor.size) {
    throw new Error(`MuScriptor release file must map to exactly one asset: ${descriptor.destination}`)
  }
  const part = descriptor.parts[0]
  const url = `https://huggingface.co/${manifest.modelId}/resolve/${manifest.revision}/${encodedModelPath(descriptor.destination)}`
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'follow',
  })
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${descriptor.destination}: HTTP ${response.status}`)
  }

  const target = path.join(outputDirectory, part.asset)
  const handle = await fs.open(target, 'wx')
  const hash = crypto.createHash('sha256')
  let size = 0
  try {
    for await (const value of response.body) {
      const chunk = Buffer.from(value)
      let offset = 0
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset)
        if (bytesWritten <= 0) throw new Error(`Could not write ${descriptor.destination}.`)
        offset += bytesWritten
      }
      hash.update(chunk)
      size += chunk.length
    }
  } finally {
    await handle.close()
  }
  if (size !== descriptor.size) throw new Error(`Downloaded size mismatch for ${descriptor.destination}.`)
  const digest = hash.digest('hex')
  if (digest !== descriptor.sha256 || digest !== part.sha256) {
    throw new Error(`Digest mismatch for ${descriptor.destination}.`)
  }
}

const assertUniversalVariants = (manifest) => {
  const variants = ['darwin-arm64', 'win32-x64', 'linux-x64'].map((key) => manifest.variants?.[key])
  if (variants.some((variant) => !variant)) throw new Error('MuScriptor must define macOS, Windows, and Linux release variants.')
  const canonical = JSON.stringify(variants[0].files)
  if (variants.some((variant) => JSON.stringify(variant.files) !== canonical)) {
    throw new Error('MuScriptor release files must be identical on every desktop platform.')
  }
  const tags = new Set(variants.map((variant) => variant.release?.tag))
  if (tags.size !== 1 || !variants[0].release?.tag) throw new Error('MuScriptor variants must share one release tag.')
  return variants[0]
}

export const prepareMuscriptorReleaseBundle = async ({
  manifest,
  outputDirectory,
  token,
  fetchImpl = globalThis.fetch,
  manifestPath = defaultManifestPath,
  noticePath = defaultNoticePath,
}) => {
  if (!String(token || '').trim()) throw new Error('HF_TOKEN is required to prepare the gated source bundle.')
  if (typeof fetchImpl !== 'function') throw new Error('This Node.js runtime does not provide fetch().')
  const variant = assertUniversalVariants(manifest)
  await fs.mkdir(outputDirectory, { recursive: true })
  if ((await fs.readdir(outputDirectory)).length > 0) throw new Error('The MuScriptor release output directory must be empty.')

  for (const descriptor of variant.files) {
    await downloadAsset({
      descriptor,
      manifest,
      outputDirectory,
      token: String(token).trim(),
      fetchImpl,
    })
  }

  const notice = manifest.commonFiles?.find((file) => file.destination === 'VIBESEQ_MUSCRIPTOR_NOTICE.txt')
  if (!notice || notice.parts.length !== 1) throw new Error('The MuScriptor notice descriptor is missing.')
  const noticeStat = await fs.stat(noticePath)
  if (
    noticeStat.size !== notice.size
    || notice.parts[0].size !== notice.size
    || notice.parts[0].sha256 !== notice.sha256
    || await sha256File(noticePath) !== notice.sha256
  ) {
    throw new Error('The MuScriptor notice does not match its pinned manifest digest.')
  }
  await fs.copyFile(noticePath, path.join(outputDirectory, notice.parts[0].asset))
  await fs.copyFile(manifestPath, path.join(outputDirectory, 'muscriptor-model-bundle.json'))
  return { tag: variant.release.tag, outputDirectory }
}

const argumentValue = (name) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const manifestPath = argumentValue('--manifest') || defaultManifestPath
  const outputDirectory = argumentValue('--output')
  if (!outputDirectory) throw new Error('Usage: node scripts/prepare-muscriptor-release.mjs --output <empty-directory>')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  const result = await prepareMuscriptorReleaseBundle({
    manifest,
    outputDirectory: path.resolve(outputDirectory),
    token: process.env.HF_TOKEN,
    manifestPath,
  })
  process.stdout.write(`Prepared ${result.tag} release assets.\n`)
}
