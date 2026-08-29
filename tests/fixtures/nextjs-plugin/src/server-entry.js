const { shared } = require('../lib/shared.js')
const { serverOnly } = require('../lib/server-only.js')

module.exports = { render: () => shared() + serverOnly() }
