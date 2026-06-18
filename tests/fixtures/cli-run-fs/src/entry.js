// Exercises `stasis run --fs`: explicit sync filesystem reads that are captured
// into the bundle (bundle=add) and served back from it (bundle=load). Uses only
// fs.readFileSync and fs.readdirSync (the patched surface); the assets live next
// to this module so the paths resolve under the project root.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const assets = join(import.meta.dirname, 'assets')

// resource (raw UTF-8), json (code-by-extension), resource:base64 (binary)
const message = readFileSync(join(assets, 'message.txt'), 'utf8')
const data = JSON.parse(readFileSync(join(assets, 'data.json'), 'utf8'))
const blob = readFileSync(join(assets, 'blob.bin'))

// directory: a single-argument readdirSync. Sort for deterministic output -- the
// captured/served listing is sorted too, but the on-disk capture order is not.
const names = readdirSync(assets).sort()

console.log(`message:${message.trim()}`)
console.log(`data:${data.k}`)
console.log(`blob:${blob.length}:${blob.toString('base64')}`)
console.log(`dir:${names.join(',')}`)
