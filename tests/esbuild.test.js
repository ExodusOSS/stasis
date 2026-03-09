import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import * as esbuild from 'esbuild'
import { StasisEsbuild } from '../src/esbuild.js'

const dist = join(import.meta.dirname, '../tests.dist')

await esbuild.build({
  entryPoints: [join(import.meta.dirname, 'bytes.test.js')],
  bundle: true,
  outdir: join(import.meta.dirname, '../tests.dist'),
  platform: 'node',
  format: 'esm',
  keepNames: true,
  plugins: [new StasisEsbuild()],
})

await rm(dist, { recursive: true })
