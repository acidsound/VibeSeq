const assert = require('node:assert/strict')
const net = require('node:net')
const test = require('node:test')

const {
  LOOPBACK_HOST,
  findAvailablePort,
} = require('./port-selection.cjs')

const listen = (port) => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(port, LOOPBACK_HOST, () => resolve(server))
})

const close = (server) => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve())
})

test('uses the preferred Electron port when it is available', async () => {
  const port = await findAvailablePort(10_000, {
    canListen: async (candidate) => candidate === 10_000,
  })
  assert.equal(port, 10_000)
})

test('moves upward one port at a time when preferred ports are occupied', async () => {
  const checked = []
  const port = await findAvailablePort(10_000, {
    canListen: async (candidate) => {
      checked.push(candidate)
      return candidate === 10_002
    },
  })
  assert.equal(port, 10_002)
  assert.deepEqual(checked, [10_000, 10_001, 10_002])
})

test('detects a real loopback port collision', async () => {
  const occupied = await listen(0)
  const address = occupied.address()
  const occupiedPort = typeof address === 'object' && address ? address.port : null
  assert.notEqual(occupiedPort, null)
  try {
    assert.ok(await findAvailablePort(occupiedPort) > occupiedPort)
  } finally {
    await close(occupied)
  }
})

test('rejects invalid preferred ports', async () => {
  await assert.rejects(findAvailablePort(0), RangeError)
  await assert.rejects(findAvailablePort(65_536), RangeError)
})
