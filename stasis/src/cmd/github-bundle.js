import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { brotliCompressSync } from 'node:zlib'

import { brotliOptions } from '@exodus/stasis-core/brotli'
import { createClient } from '@preventive/upstream/github.js'
import { buildGitHubBundle } from '../vfs-bundle/github.js'

// Run `stasis github-bundle`: the bundle of a GitHub repo at a commit (the default branch's head
// without one), as buildGitHubBundle builds it from `options`, written brotli-compressed to `output`
// (stasis.code.br by default, `-` for stdout), and a JS bundle's lockfile to `lockfile` where given.
// The tree is fetched with GITHUB_TOKEN from `env` where it is set.
export async function githubBundleCommand({ cwd = process.cwd(), env = process.env, output = 'stasis.code.br', lockfile, brotliQuality, client, ...options } = {}) {
  if (lockfile !== undefined && options.packageManager === 'soldeer') throw new Error('github-bundle: --lockfile is only valid for JS bundles')
  const built = await buildGitHubBundle({ ...options, env, client: client ?? createClient({ token: env.GITHUB_TOKEN || null }) })
  const write = (path, data) => {
    const at = resolve(cwd, path)
    mkdirSync(dirname(at), { recursive: true })
    writeFileSync(at, data)
  }
  const data = brotliCompressSync(built.bundle.serialize(), brotliOptions(brotliQuality))
  if (output === '-') process.stdout.write(data)
  else write(output, data)
  if (lockfile !== undefined) write(lockfile, built.lockfile.serialize())
  const packages = [...built.bundle.modules.values()].filter((m) => Object.keys(m.files).length > 0).length
  const from = `${options.github}@${built.bundle.repo.commit}${options.directory ? `/${options.directory}` : ''}`
  console.warn(`[stasis] Bundled ${built.bundle.sources.size} files in ${packages} package${packages === 1 ? '' : 's'} from ${from} to ${output === '-' ? '<stdout>' : output}`)
}
