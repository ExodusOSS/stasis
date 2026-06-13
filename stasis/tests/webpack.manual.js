import { resolve } from 'node:path'
import { rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import webpack from 'webpack'
import { StasisWebpack } from '../src/webpack.js'

const entry = resolve(import.meta.dirname, 'bytes.test.js')
const dist = resolve(import.meta.dirname, '../tests.dist/webpack')

const compiler = webpack({
  mode: 'production',
  entry,
  output: { path: dist, filename: 'bytes.test.cjs' },
  module: {
    rules: [
      {
        test: /node_modules\/@exodus\/bytes\/(fallback\/)?.*\.js$/,
        loader: 'string-replace-loader',
        options: {
          // Hack, but better than loading Babel here
          multiple: [
            { search: /( (?:0x)?\d+)_/gu, replace: '$1' },
            { search: /( (?:0x)?\d+)_/gu, replace: '$1' },
            { search: /( (?:0x)?\d+)_/gu, replace: '$1' },
            { search: 'nativeEncoder?.encodeInto', replace: 'nativeEncoder.encodeInto' },
          ]
        },
      },
    ]
  },
  externals: {
    'node:test': 'commonjs node:test',
  },
  plugins: [
    new StasisWebpack(),
  ],
})

const stats = await promisify(compiler.run.bind(compiler))()

console.log(stats.toString({ colors: true }))

await rm(dist, { recursive: true })
