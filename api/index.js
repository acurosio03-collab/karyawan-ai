'use strict';
// Titik masuk Vercel Function untuk seluruh REST API (/api/*).
const { handle } = require('./_app');
module.exports = (req, res) => handle(req, res);
