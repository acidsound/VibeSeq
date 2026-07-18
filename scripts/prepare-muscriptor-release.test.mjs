import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { prepareMuscriptorReleaseBundle } from './prepare-muscriptor-release.mjs'

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')

test('prepares one authenticated MuScriptor release bundle shared by every desktop platform', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeseq-muscriptor-release-'))
  const outputDirectory = path.join(root, 'output')
  const source = Buffer.from('model')
  const notice = Buffer.from('notice')
  const noticePath = path.join(root, 'NOTICE.txt')
  const manifestPath = path.join(root, 'manifest.json')
  await fs.writeFile(noticePath, notice)
  const descriptor = {
    destination: 'model.safetensors',
    size: source.length,
    sha256: sha256(source),
    parts: [{ asset: 'model.safetensors', size: source.length, sha256: sha256(source) }],
  }
  const variant = {
    release: { tag: 'muscriptor-test' },
    files: [descriptor],
  }
  const manifest = {
    modelId: 'MuScriptor/test-medium',
    revision: 'exact-revision',
    commonFiles: [{
      destination: 'VIBESEQ_MUSCRIPTOR_NOTICE.txt',
      size: notice.length,
      sha256: sha256(notice),
      parts: [{ asset: 'MuScriptor-NOTICE.txt', size: notice.length, sha256: sha256(notice) }],
    }],
    variants: {
      'darwin-arm64': variant,
      'win32-x64': variant,
      'linux-x64': variant,
    },
  }
  await fs.writeFile(manifestPath, JSON.stringify(manifest))
  let request
  const fetchImpl = async (url, options) => {
    request = { url, options }
    return new Response(source)
  }

  const result = await prepareMuscriptorReleaseBundle({
    manifest,
    outputDirectory,
    token: 'hf_maintainer_token',
    fetchImpl,
    manifestPath,
    noticePath,
  })

  assert.equal(result.tag, 'muscriptor-test')
  assert.equal(request.url, 'https://huggingface.co/MuScriptor/test-medium/resolve/exact-revision/model.safetensors')
  assert.equal(request.options.headers.Authorization, 'Bearer hf_maintainer_token')
  assert.deepEqual(await fs.readFile(path.join(outputDirectory, 'model.safetensors')), source)
  assert.deepEqual(await fs.readFile(path.join(outputDirectory, 'MuScriptor-NOTICE.txt')), notice)
  assert.equal(JSON.parse(await fs.readFile(path.join(outputDirectory, 'muscriptor-model-bundle.json'))).revision, 'exact-revision')
})
