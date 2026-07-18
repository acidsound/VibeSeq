import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { prepareGpuReleaseBundle } from './prepare-stable-audio-gpu-release.mjs'

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')

test('streams an authenticated source file into public release parts and verifies the final digest', async () => {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibeseq-gpu-release-'))
  const source = Buffer.from('abcdef')
  const manifest = {
    modelId: 'stabilityai/test-model',
    revision: 'exact-revision',
    commonFiles: [],
    variants: {
      'win32-x64': {
        release: { tag: 'gpu-test-release' },
        files: [{
          destination: 'model.safetensors',
          size: source.length,
          sha256: sha256(source),
          parts: [
            { asset: 'model.part-000', size: 3 },
            { asset: 'model.part-001', size: 3 },
          ],
        }],
      },
    },
  }
  let request
  const fetchImpl = async (url, options) => {
    request = { url, options }
    return new Response(source)
  }

  const result = await prepareGpuReleaseBundle({
    manifest,
    outputDirectory,
    token: 'hf_maintainer_token',
    fetchImpl,
    manifestPath: null,
    noticePath: null,
  })

  assert.equal(result.tag, 'gpu-test-release')
  assert.equal(request.url, 'https://huggingface.co/stabilityai/test-model/resolve/exact-revision/model.safetensors')
  assert.equal(request.options.headers.Authorization, 'Bearer hf_maintainer_token')
  assert.deepEqual(await fs.readFile(path.join(outputDirectory, 'model.part-000')), Buffer.from('abc'))
  assert.deepEqual(await fs.readFile(path.join(outputDirectory, 'model.part-001')), Buffer.from('def'))
})
