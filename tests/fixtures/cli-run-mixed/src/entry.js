import { greet as greetEsm } from 'fake-esm-pkg'
import { greet as greetCjs } from 'fake-cjs-pkg'

console.log(greetEsm('esm'))
console.log(greetCjs('cjs'))
