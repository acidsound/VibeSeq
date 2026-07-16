import { lstatSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const root = resolve(process.argv[2] || 'release')
const forbiddenNames = new Set([
  'models--stabilityai--stable-audio-3-optimized',
  'models--MuScriptor--muscriptor-medium',
  'dit_medium_f16.npz',
  'same_l_decoder_f32.npz',
  't5gemma_f16.npz',
  'model.safetensors',
  'dit_w8a8-dyn.tflite',
  'dec_w8a8-dyn.tflite',
  'encoder_fp16.tflite',
])
const findings = []
const pending = [root]

while (pending.length > 0) {
  const current = pending.pop()
  if (!current) continue
  const name = basename(current)
  if (forbiddenNames.has(name)) findings.push(current)
  const stat = lstatSync(current)
  if (!stat.isDirectory() || stat.isSymbolicLink()) continue
  for (const entry of readdirSync(current)) pending.push(join(current, entry))
}

if (findings.length > 0) {
  throw new Error(`Desktop package contains model weights:\n${findings.join('\n')}`)
}

console.log(`Verified model-free desktop package under ${root}`)
