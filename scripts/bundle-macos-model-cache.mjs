import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const appPath = resolve(process.argv[2] || 'release/mac-arm64/VibeSeq.app')
const sourceHub = resolve(
  process.env.HUGGINGFACE_HUB_CACHE
    || join(process.env.HF_HOME || join(homedir(), '.cache', 'huggingface'), 'hub'),
)
const targetHub = join(appPath, 'Contents', 'Resources', 'models', 'huggingface', 'hub')

const models = [
  {
    repository: 'models--stabilityai--stable-audio-3-optimized',
    revision: 'c2949a435de2392fe49c5914c52bc174cfc05a9b',
    files: [
      'MLX/dit_medium_f16.npz',
      'MLX/same_l_decoder_f32.npz',
      'MLX/t5gemma_f16.npz',
    ],
  },
  {
    repository: 'models--MuScriptor--muscriptor-medium',
    revision: 'f32236969308476e01fd3aae67357de5feb05a2d',
    files: ['config.json', 'model.safetensors'],
  },
]

rmSync(targetHub, { recursive: true, force: true })

for (const model of models) {
  const sourceRepository = join(sourceHub, model.repository)
  const targetRepository = join(targetHub, model.repository)
  for (const filename of model.files) {
    const sourceSnapshotFile = join(sourceRepository, 'snapshots', model.revision, filename)
    const stat = lstatSync(sourceSnapshotFile)
    if (!stat.isSymbolicLink()) {
      throw new Error(`Expected a Hugging Face cache symlink: ${sourceSnapshotFile}`)
    }
    const link = readlinkSync(sourceSnapshotFile)
    const sourceBlob = resolve(dirname(sourceSnapshotFile), link)
    const targetBlob = join(targetRepository, 'blobs', basename(sourceBlob))
    const targetSnapshotFile = join(targetRepository, 'snapshots', model.revision, filename)
    mkdirSync(dirname(targetBlob), { recursive: true })
    mkdirSync(dirname(targetSnapshotFile), { recursive: true })
    rmSync(targetBlob, { force: true })
    const clone = spawnSync('/bin/cp', ['-c', sourceBlob, targetBlob], {
      encoding: 'utf8',
    })
    if (clone.status !== 0) {
      throw new Error(`Could not APFS-clone ${sourceBlob}: ${clone.stderr.trim()}`)
    }
    const targetLink = relative(dirname(targetSnapshotFile), targetBlob)
    symlinkSync(isAbsolute(targetLink) ? targetBlob : targetLink, targetSnapshotFile)
  }
}

console.log(`Bundled exact medium model cache into ${appPath}`)
