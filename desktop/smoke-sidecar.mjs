import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const host = '127.0.0.1'
const executableName = process.platform === 'win32' ? 'vibeseq-inference.exe' : 'vibeseq-inference'
const executable = path.resolve('desktop-out', 'sidecar', 'vibeseq-inference', executableName)
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vibeseq-desktop-smoke-'))

const port = await new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, host, () => {
    const address = server.address()
    const selected = typeof address === 'object' && address ? address.port : null
    server.close((error) => error ? reject(error) : resolve(selected))
  })
})

if (port === null) throw new Error('Could not allocate a smoke-test port.')

const child = spawn(executable, [], {
  env: {
    ...process.env,
    VIBESEQ_HOST: host,
    VIBESEQ_PORT: String(port),
    VIBESEQ_STUDIO_DIST: path.resolve('dist'),
    VIBESEQ_DATA_DIR: dataDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

let output = ''
child.stdout.on('data', (chunk) => { output += chunk.toString() })
child.stderr.on('data', (chunk) => { output += chunk.toString() })

const deadline = Date.now() + 30_000
try {
  let ready = false
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const [health, studio] = await Promise.all([
        fetch(`http://${host}:${port}/api/health`),
        fetch(`http://${host}:${port}/`),
      ])
      const studioHtml = await studio.text()
      if (health.ok && studio.ok && studioHtml.includes('<title>VibeSeq</title>')) {
        ready = true
        break
      }
    } catch {
      // The sidecar is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (!ready) throw new Error(`Desktop sidecar smoke test failed.\n${output}`)
  process.stdout.write(`Desktop sidecar ready on ${host}:${port}\n`)
} finally {
  child.kill()
}
