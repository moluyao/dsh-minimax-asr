/**
 * Installed-state check: assert what the running harness must see.
 *
 * Resolves the plugin exactly as the profile does (the profile directory is the
 * resolution anchor), then checks every fact the host's client-package scanner
 * depends on, plus the single-activation-row invariant that keeps the tool from
 * being registered twice.
 *
 * Usage: node tests/installed-check.mjs [profile-dir]
 */

import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// The profile to inspect: the argument, else $DSH_HOME/profiles/web.
const profileArg = process.argv[2]
  ?? (process.env.DSH_HOME === undefined ? undefined : join(process.env.DSH_HOME, 'profiles', 'web'))
if (profileArg === undefined) {
  console.error('usage: node tests/installed-check.mjs <profile-dir>')
  console.error('  e.g. node tests/installed-check.mjs ~/.dsh/profiles/web')
  process.exit(2)
}
const profileDir = resolve(profileArg)

function check(condition, label) {
  if (!condition) throw new Error(`FAIL: ${label}`)
  console.log(`ok - ${label}`)
}

const require = createRequire(join(profileDir, 'package.json'))

// 1. The profile resolves the package by the loader name its row uses.
const manifestPath = require.resolve('dsh-minimax-asr/package.json')
const packageDir = dirname(manifestPath)
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
check(manifest.name === 'dsh-minimax-asr', `resolved ${manifest.name} at ${packageDir}`)

// 2. Bundle patch: `dsh plugin` only activates a package that declares one.
const patchRel = manifest.dsh?.bundle?.patch
check(typeof patchRel === 'string', `dsh.bundle.patch = ${JSON.stringify(patchRel)}`)
const patchText = await readFile(join(packageDir, patchRel), 'utf8')
check(/id:\s*minimax-asr/.test(patchText) && /name:\s*'dsh-minimax-asr'/.test(patchText), 'bundle patch inserts id/name minimax-asr')

// 3. Browser half: platform gate, "./client" export, readable bytes, matching id.
check(manifest.dsh?.client?.platform === 'web', `dsh.client.platform = ${JSON.stringify(manifest.dsh?.client?.platform)}`)
const clientExport = manifest.exports?.['./client']
const clientRel = typeof clientExport === 'string' ? clientExport : clientExport?.default
check(typeof clientRel === 'string', `exports["./client"] = ${JSON.stringify(clientRel)}`)
const clientPath = join(packageDir, clientRel)
const clientSource = await readFile(clientPath, 'utf8')
check(clientSource.length > 0, `client bundle readable (${clientSource.length} bytes)`)
const loadId = /window\.__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(clientSource)
check(loadId !== null, 'client bundle calls window.__ModuleLoader__.load')
check(loadId?.[1] === manifest.name, `bundle id ${JSON.stringify(loadId?.[1])} matches the package/loader name`)
check(!/^\s*(import|export)\s/m.test(clientSource.split('\n').filter(line => !line.includes('exports.')).join('\n')), 'client bundle contains no ESM statements (classic script)')

// 4. Everything the browser half declares must resolve from the profile.
for (const dependency of manifest.dsh.client.inject ?? []) {
  require.resolve(`${dependency}/package.json`)
  check(true, `client inject resolves: ${dependency}`)
}

// 5. The host half must load and export the cordis plugin shape.
const hostRel = manifest.exports?.['.']?.default ?? manifest.exports?.['.'] ?? manifest.main
const host = await import(pathToFileURL(join(packageDir, hostRel)).href)
check(host.name === 'minimax-asr', `host half exports name ${JSON.stringify(host.name)}`)
check(typeof host.apply === 'function', 'host half exports apply')

// 6. Exactly one activation site. The package carries its own bundle patch, so
// `dsh plugin add` records it in the profile's bundle list; an extra `insert`
// row in cordis.patch.yml would mount the same id twice and the second mount
// would fail on the duplicate tool registration.
const profile = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
const bundles = profile.dsh?.profile?.bundles ?? []
const inBundles = bundles.includes('dsh-minimax-asr')
const profilePatch = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')
// Comments in that file talk about the row shape, so only real YAML counts.
const activePatch = profilePatch
  .split('\n')
  .filter(line => !/^\s*#/u.test(line))
  .join('\n')
const rows = activePatch.match(/id:\s*minimax-asr/g) ?? []
check(inBundles !== (rows.length > 0), `activated exactly once (bundles: ${inBundles}, patch rows: ${rows.length})`)
if (inBundles) {
  check(bundles.filter(name => name === 'dsh-minimax-asr').length === 1, `bundle list names it once (${bundles.join(', ')})`)
} else {
  check(rows.length === 1, `exactly one activation row in cordis.patch.yml (${rows.length})`)
}
check(profile.dependencies?.['dsh-minimax-asr'] !== undefined, 'package stays an installed dependency')

console.log('\ninstalled state: all checks passed')
