import { fmt } from '@lib/format'

export default function About(): unknown {
  return <p>{fmt('about' as string)}</p>
}
