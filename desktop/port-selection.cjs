const net = require('node:net')

const LOOPBACK_HOST = '127.0.0.1'
const MAX_PORT = 65_535

const canListen = (port, host = LOOPBACK_HOST) => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.unref()
  server.once('error', (error) => {
    if (error?.code === 'EADDRINUSE' || error?.code === 'EACCES') resolve(false)
    else reject(error)
  })
  server.listen(port, host, () => {
    server.close((error) => {
      if (error) reject(error)
      else resolve(true)
    })
  })
})

const findAvailablePort = async (startPort, options = {}) => {
  const host = options.host ?? LOOPBACK_HOST
  const check = options.canListen ?? canListen
  if (!Number.isInteger(startPort) || startPort < 1 || startPort > MAX_PORT) {
    throw new RangeError(`startPort must be an integer between 1 and ${MAX_PORT}.`)
  }

  for (let port = startPort; port <= MAX_PORT; port += 1) {
    if (await check(port, host)) return port
  }
  throw new Error(`No available loopback port at or above ${startPort}.`)
}

module.exports = {
  LOOPBACK_HOST,
  canListen,
  findAvailablePort,
}
