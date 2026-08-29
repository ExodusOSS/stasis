const { secret } = require('../../lib/secret.js')

module.exports = function handler(req, res) {
  res.end(secret())
}
