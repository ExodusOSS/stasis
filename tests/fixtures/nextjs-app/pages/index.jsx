import { greet } from '../lib/greet.js'
import { pick } from 'dual-pkg'

export default function Home() {
  return <h1>{greet(pick())}</h1>
}
