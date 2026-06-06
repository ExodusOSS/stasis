import { greet } from './hello.js'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'

const log = (kind, fn) => {
  try { fn(); console.log(kind, 'NOT BLOCKED') }
  catch (e) { console.log(kind, 'blocked', e.code ?? e.message) }
}

const sentinel = process.env.STASIS_MOCK_SENTINEL
const port = Number(process.env.STASIS_MOCK_PORT ?? 54321)

log('write', () => writeFileSync(sentinel, 'pwned'))
log('spawn', () => spawnSync('node', ['-e', 'process.exit(0)']))

const srv = createServer()
srv.listen(port, () => console.log('listen', 'NOT BLOCKED'))
console.log('listening?', srv.listening)
srv.close()

console.log(greet('world'))
