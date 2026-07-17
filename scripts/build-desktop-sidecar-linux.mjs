import { rmSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('The portable CPU sidecar build only supports linux-x64.')
}

const root = process.cwd()
const server = path.join(root, 'server')
const environment = path.join(root, 'desktop-out', 'linux-python')
const python = path.join(environment, 'bin', 'python')

const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] || ''} failed with exit code ${result.status}`)
  }
}

rmSync(environment, { recursive: true, force: true })
run('uv', ['venv', '--python', '3.12', environment])
run('uv', [
  'pip',
  'sync',
  '--python',
  python,
  '--torch-backend',
  'cpu',
  'desktop-linux-requirements.txt',
], server)
run(python, [
  '-c',
  "import torch; assert torch.__version__.endswith('+cpu'); print(f'Linux desktop torch: {torch.__version__}')",
])
run(python, [
  '-m',
  'PyInstaller',
  '--noconfirm',
  '--clean',
  '--distpath',
  'desktop-out/sidecar',
  '--workpath',
  'desktop-out/pyinstaller',
  'desktop/vibeseq-inference.spec',
])
