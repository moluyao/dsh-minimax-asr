/**
 * Throwaway static server for the icon preview page (verification only).
 * Usage: node tests/serve-preview.mjs [port]
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const port = Number(process.argv[2] ?? 3210)

const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript; charset=utf-8' }

createServer(async (req, res) => {
  const relative = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^([/\\])+/u, '')
  const file = join(root, relative === '' ? 'icon-preview.html' : relative)
  if (!file.startsWith(root)) {
    res.writeHead(403).end('no')
    return
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`preview server: http://127.0.0.1:${port}/icon-preview.html`)
})
