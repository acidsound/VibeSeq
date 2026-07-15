import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repository = 'https://github.com/Stability-AI/stable-audio-3.git'
const revision = 'b32763cf3b71c160f10a0daa4fa0e0d471b5772e'
const output = path.resolve('desktop-out', 'model-runtime-source')
const markerName = '.vibeseq-source.json'
const marker = path.join(output, markerName)

const current = () => {
  try {
    const value = JSON.parse(readFileSync(marker, 'utf8'))
    return value.repository === repository
      && value.revision === revision
      && existsSync(path.join(output, 'optimized', 'mlx', 'scripts', 'sa3_mlx.py'))
      && existsSync(path.join(output, 'optimized', 'tflite', 'scripts', 'sa3_tflite.py'))
  } catch {
    return false
  }
}

const run = (args, cwd) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args[0]} failed with exit code ${result.status}`)
}

if (!current()) {
  const temporary = `${output}.tmp-${process.pid}`
  rmSync(temporary, { recursive: true, force: true })
  mkdirSync(path.dirname(output), { recursive: true })
  try {
    run(['clone', '--filter=blob:none', '--no-checkout', repository, temporary])
    run(['checkout', '--detach', revision], temporary)
    rmSync(path.join(temporary, '.git'), { recursive: true, force: true })
    writeFileSync(
      path.join(temporary, markerName),
      `${JSON.stringify({ repository, revision })}\n`,
      'utf8',
    )
    rmSync(output, { recursive: true, force: true })
    renameSync(temporary, output)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

process.stdout.write(`Prepared Stable Audio runtime source ${revision.slice(0, 12)}\n`)
