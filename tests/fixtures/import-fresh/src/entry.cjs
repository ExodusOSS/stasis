const importFresh = require('import-fresh')

const a = require('./counter.cjs') // eval #1 -> 1
const b = require('./counter.cjs') // cached   -> 1
const c = importFresh('./counter.cjs') // fresh -> 2
const d = importFresh('./counter.cjs') // fresh -> 3

console.log(JSON.stringify([a, b, c, d]))
