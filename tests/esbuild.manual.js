import { resolve } from 'node:path'
import { rm } from 'node:fs/promises'
import * as esbuild from 'esbuild'
import { StasisEsbuild } from '../stasis/src/esbuild.js'

const entry = resolve(import.meta.dirname, 'bytes.test.js')
const dist = resolve(import.meta.dirname, '../tests.dist/esbuild')

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  outdir: dist,
  platform: 'node',
  format: 'esm',
  keepNames: true,
  plugins: [new StasisEsbuild()],
})

await rm(dist, { recursive: true })
