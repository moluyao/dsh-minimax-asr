/**
 * Byte-order-mark check: a shipped file that starts with U+FEFF fails the host.
 *
 * The profile boot reads each bundle's package.json with JSON.parse, which keeps a
 * leading BOM as a character, so a BOM'd manifest aborts profile composition and the
 * port never binds. `dsh-minimax-asr` is installed as a `link:` bundle, so this
 * working tree IS the file the host reads. Editors and PowerShell both emit UTF-8
 * with BOM silently, so this scans every file rather than the ones that matter today.
 *
 * Usage: node tests/no-bom.mjs
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const skipped = new Set(['node_modules', '.git'])

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile()) yield path
  }
}

const offences = []
for await (const path of walk(root)) {
  const bytes = await readFile(path)
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) offences.push(relative(root, path))
}

if (offences.length > 0) {
  console.error(`FAIL: ${offences.length} file(s) start with a UTF-8 BOM:`)
  for (const path of offences) console.error(`  ${path.split('\\').join('/')}`)
  console.error('Re-save them without a BOM. JSON.parse does not strip U+FEFF, so a BOM in a')
  console.error('manifest or bundle patch stops the harness from booting.')
  process.exit(1)
}

console.log(`ok - no BOM under ${root.split('\\').join('/')}`)
