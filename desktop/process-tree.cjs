const { spawnSync } = require('node:child_process')

const terminateProcessTree = (
  child,
  {
    platform = process.platform,
    spawnSyncImpl = spawnSync,
  } = {},
) => {
  if (!child || child.exitCode !== null) return false
  if (platform === 'win32' && Number.isInteger(child.pid)) {
    const result = spawnSyncImpl(
      'taskkill.exe',
      ['/pid', String(child.pid), '/t', '/f'],
      {
        windowsHide: true,
        stdio: 'ignore',
      },
    )
    if (!result?.error && result?.status === 0) return true
  }
  child.kill()
  return true
}

module.exports = { terminateProcessTree }
