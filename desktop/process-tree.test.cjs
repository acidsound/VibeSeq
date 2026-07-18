const assert = require('node:assert/strict')
const { test } = require('node:test')

const { terminateProcessTree } = require('./process-tree.cjs')

test('Windows shutdown terminates the complete child process tree', () => {
  const calls = []
  let fallbackKills = 0
  const child = {
    pid: 4321,
    exitCode: null,
    kill: () => { fallbackKills += 1 },
  }

  assert.equal(terminateProcessTree(child, {
    platform: 'win32',
    spawnSyncImpl: (command, args, options) => {
      calls.push({ command, args, options })
      return { status: 0 }
    },
  }), true)

  assert.deepEqual(calls[0].args, ['/pid', '4321', '/t', '/f'])
  assert.equal(calls[0].options.windowsHide, true)
  assert.equal(fallbackKills, 0)
})

test('process-tree shutdown falls back to the child handle when taskkill fails', () => {
  let fallbackKills = 0
  const child = {
    pid: 4321,
    exitCode: null,
    kill: () => { fallbackKills += 1 },
  }

  assert.equal(terminateProcessTree(child, {
    platform: 'win32',
    spawnSyncImpl: () => ({ status: 1 }),
  }), true)
  assert.equal(fallbackKills, 1)
})

test('process-tree shutdown ignores a process that already exited', () => {
  let invoked = false
  const child = {
    pid: 4321,
    exitCode: 0,
    kill: () => { invoked = true },
  }

  assert.equal(terminateProcessTree(child, {
    platform: 'win32',
    spawnSyncImpl: () => { invoked = true },
  }), false)
  assert.equal(invoked, false)
})
