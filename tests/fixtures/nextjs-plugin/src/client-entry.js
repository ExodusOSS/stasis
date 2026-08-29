const { shared } = require('../lib/shared.js')
const { clientOnly } = require('../lib/client-only.js')

module.exports = { hydrate: () => shared() + clientOnly() }
