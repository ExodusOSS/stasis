const { greet } = require('fake-cjs-pkg')
const { who } = require('./helper.js')
console.log(greet(who))
