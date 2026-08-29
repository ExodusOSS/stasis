import { greet } from '../lib/greet.js'
import { pick } from 'dual-pkg'
import { where } from 'node-first-pkg'
import { env } from '../lib/env'

export default function Home() {
  return <h1>{greet(pick())} {where()} {env}</h1>
}
