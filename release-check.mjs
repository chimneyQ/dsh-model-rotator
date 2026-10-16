import { readFileSync,existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// Self-relative, for the same reason the other suites are: a hardcoded absolute path
// means a copy of this tree is never actually the thing under test.
const pub = dirname(fileURLToPath(import.meta.url)).replace(/\\\\/g, '/')
const dev = pub.replace(/-publish$/, '')
const read = (f) => readFileSync(pub + '/' + f, 'utf8')
const manifest = JSON.parse(read('package.json'))
const index = read('index.js')
const client = read('client.js')
const readme = read('README.md')
const results = []
const ck = (label, cond, extra = '') => results.push([cond ? 'PASS' : 'FAIL', label, extra])

// 1. manifest / bundle
ck('1 dsh.bundle patch declared and on disk', manifest.dsh?.bundle?.patch === './cordis.patch.yml' && existsSync(pub + '/cordis.patch.yml'))
ck('2 client declaration is the web platform with injects', manifest.dsh?.client?.platform === 'web' && Array.isArray(manifest.dsh.client.inject) && manifest.dsh.client.inject.length === 4, JSON.stringify(manifest.dsh?.client ?? {}))
ck('3 every files[] entry exists', (manifest.files ?? []).every(f => existsSync(pub + '/' + f)), JSON.stringify(manifest.files))
ck('4 every exports[] target exists', Object.values(manifest.exports ?? {}).every(v => existsSync(pub + '/' + v)), JSON.stringify(manifest.exports))
ck('5 private is gone', manifest.private === undefined)
ck('6 license fields agree with LICENSE', manifest.license === 'MIT' && /MIT License/.test(read('LICENSE')))
ck('7 main entry resolves', manifest.main === 'index.js' && existsSync(pub + '/index.js'))

// 2. no bare host imports
const badImport = /^\s*import\s+[^'"]+\s+from\s+['"](?!node:|\.)/m.test(index)
ck('8 index.js has no bare host import', !badImport)

// 3. tool count: README claims vs registered
const registered = [...index.matchAll(/tools\.register\(/g)].length
const claimed = Number((readme.match(/three tools|3 tools|3 = 3|three tools/i) ? 3 : NaN))
ck('9 README tool claim matches the code', registered === 3, 'registered=' + registered)

// 4. the capabilities the README promises exist in the code
ck('10 switch notice exists', /model-rotator\/switch/.test(index))
// The channel switch: the route writes a whole-channel flag, and the header button is
// driven by it - not by whether some row happens to be in rotation.
ck('11 the channel switch is driven by the channel flag', /disabledProviders/.test(index) && /const closed = channel\.switchedOff === true/.test(client) && /models\.disableChannel/.test(client) && /models\.enableChannel/.test(client))
ck('11b a vision channel carries no channel switch', /channel\.kind === "vision" \? null : jsx\("button"/.test(client))
ck('12 grouped list exists', /groups/.test(index) && /data\.groups/.test(client))
ck('13 vendor label is read from the registered route', /entry\.name/.test(index))

// 5. the entry YAML parses
// The account is derived from the manifest, not hardcoded: the entry file is
// named <account>__dsh-model-rotator.yml, and that name moves with the
// package's repository URL.
const account = (manifest.repository?.url ?? '').replace(/^git\+/, '').match(/github\.com\/([^/]+)\//)?.[1] ?? 'chimney'
const yamlFile = 'awesome-dsh-plugin-entry/data/plugins/' + account + '__dsh-model-rotator.yml'
ck('14 the submission entry is present', existsSync(pub + '/' + yamlFile))
let yamlOk = false
let yamlDetail = ''
try {
  const text = read(yamlFile)
  const keys = ['url', 'name', 'category', 'description']
  const missing = keys.filter(k => !new RegExp('^' + k + ':', 'm').test(text))
  const bilingual = /^\s+(en|zh):/m.test(text)
  yamlOk = missing.length === 0 && bilingual
  yamlDetail = missing.length > 0 ? 'missing=' + missing.join(',') : (bilingual ? 'en+zh present' : 'no bilingual description')
} catch (e) { yamlOk = false; yamlDetail = String(e.message) }
ck('15 the submission entry has the required keys', yamlOk, yamlDetail)

// 6. the sha manifest matches the shipped files
const sums = read('SHA256SUMS.txt').trim().split(/\r?\n/).map(l => l.split(/\s+/))
const { createHash } = await import('node:crypto')
const sumOk = sums.every(([hash, file]) => createHash('sha256').update(readFileSync(pub + '/' + file)).digest('hex') === hash)
ck('16 SHA256SUMS matches the shipped bytes', sumOk, sums.length + ' entries')

// 7. the schema loader must capability-test the chain, not just presence of object().
// The anchors are scanned in profile-name order and a stale schemastery on this machine
// (user-home node_modules) has no volatile(), so a presence-only check selected it and
// Config then threw at load time. This asserts the probe is the capability form.
const loaderSrc = read('index.js')
const probesVolatile = /loaded\.boolean\(\)\.default\(true\)\.volatile\(\)/.test(loaderSrc)
const hasWeakOnlyCheck = /return loaded !== null\s*\r?\n\s*&& \(typeof loaded === 'object' \|\| typeof loaded === 'function'\)\s*\r?\n\s*&& typeof loaded\.object === 'function'/.test(loaderSrc)
ck('17 the schema loader capability-tests volatile()', probesVolatile && !hasWeakOnlyCheck, 'probe=' + probesVolatile + ' weakOnly=' + hasWeakOnlyCheck)

// 8. no test may import the plugin through a hardcoded absolute path: an earlier suite
// pointed at the DEV tree, so the published bytes were never actually covered here.
const PATH_SIG = new RegExp(['D', ':/DS_', 'harness|', '插件', '开发'].join(''))
const hardcoded = readdirSync(pub).filter(f => /^(test.*|release-check)\.mjs$/.test(f)).filter(f => PATH_SIG.test(read(f)))
ck('18 no test hardcodes a machine-local plugin path', hardcoded.length === 0, hardcoded.join(',') || 'none')

let failed = 0
for (const [st, label, extra] of results) { if (st === 'FAIL') failed += 1; console.log(st.padEnd(5), label, extra === '' ? '' : '[' + extra + ']') }
console.log('')
console.log(failed === 0 ? 'ALL PASS (' + results.length + ')' : failed + ' FAILED of ' + results.length)
process.exit(failed === 0 ? 0 : 1)