import { Color, greet } from './hello.ts'

// An enum is deliberately non-erasable: Node's built-in strip-only TypeScript mode refuses it, so
// this entry runs ONLY when the tsx preload transforms it -- proving --import tsx is load-bearing.
const c: Color = Color.Green
console.log(greet(c))
