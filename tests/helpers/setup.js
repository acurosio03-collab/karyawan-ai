'use strict';
// Menyiapkan lingkungan uji: mengganti paket "pg" dengan klien minimal, mengisi env, dan menyediakan database uji.
const Module = require('module');
const path = require('path');
const minipg = require('./minipg');
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'pg' ? minipg : origLoad.call(this, request, ...rest); };

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret-123456';
for (const k of ['OPENAI_API_KEY', 'ALT_AI_API_KEY', 'SEARCH_API_KEY', 'RESEND_API_KEY', 'WHATSAPP_TOKEN', 'CRON_SECRET']) delete process.env[k];
module.exports = { TEST_DB_URL: process.env.TEST_DATABASE_URL || '', root: path.join(__dirname, '..', '..') };
