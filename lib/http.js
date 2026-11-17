
'use strict';

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
    this.code = extra.code;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;

  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;

    try {
      out[part.slice(0, i).trim()] =
        decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // Abaikan cookie yang tidak valid.
    }
  }

  return out;
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res, status, body, headers = {}) {
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  for (const [k, v] of Object.entries(headers)) {
    res.setHeader(k, v);
  }

  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 1_000_000) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      if (!req.body.trim()) return {};
      try {
        return JSON.parse(req.body);
      } catch {
        throw new HttpError(400, 'Body JSON tidak valid');
      }
    }

    if (Buffer.isBuffer(req.body)) {
      try {
        return JSON.parse(req.body.toString('utf8') || '{}');
      } catch {
        throw new HttpError(400, 'Body JSON tidak valid');
      }
    }

    return req.body;
  }

  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (c) => {
      size += c.length;

      if (size > limit) {
        reject(new HttpError(413, 'Body terlalu besar'));
        req.destroy();
        return;
      }

      chunks.push(c);
    });

    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');

      if (!s.trim()) return resolve({});

      try {
        resolve(JSON.parse(s));
      } catch {
        reject(new HttpError(400, 'Body JSON tidak valid'));
      }
    });

    req.on('error', reject);
  });
}

function createRouter() {
  const routes = [];

  const add = (method, path, opts, handler) => {
    if (typeof opts === 'function') {
      handler = opts;
      opts = {};
    }

    const keys = [];
    const re = new RegExp(
      '^' +
      path.replace(/:([a-zA-Z_]+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      }) +
      '/?$'
    );

    routes.push({ method, path, re, keys, opts, handler });
  };

  const match = (method, p) => {
    for (const r of routes) {
      if (r.method !== method) continue;

      const m = r.re.exec(p);
      if (!m) continue;

      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });

      return { route: r, params };
    }

    return null;
  };

  return {
    routes,
    match,
    get: (...a) => add('GET', ...a),
    post: (...a) => add('POST', ...a),
    patch: (...a) => add('PATCH', ...a),
    put: (...a) => add('PUT', ...a),
    delete: (...a) => add('DELETE', ...a)
  };
}

// Terjemahkan error PostgreSQL dan aplikasi.
function toErrorResponse(e) {
  if (
    e instanceof HttpError ||
    (e && e.status && e.code === 'VALIDATION')
  ) {
    return {
      status: e.status,
      body: {
        error: e.message,
        code: e.code,
        ...(e.extra && e.extra.errors
          ? { errors: e.extra.errors }
          : {})
      }
    };
  }

  switch (e && e.code) {
    case '23505':
      return {
        status: 409,
        body: {
          error: 'Data dengan nilai yang sama sudah ada',
          code: 'DUPLICATE'
        }
      };

    case '23503':
      return {
        status: 409,
        body: {
          error: 'Data masih terhubung dengan data lain atau referensi tidak ditemukan',
          code: 'FK_CONFLICT'
        }
      };

    case '22P02':
    case '22007':
    case '22003':
      return {
        status: 400,
        body: {
          error: 'Format nilai tidak valid',
          code: 'BAD_INPUT'
        }
      };

    case '23514':
    case '23502':
      return {
        status: 400,
        body: {
          error: 'Data melanggar aturan database',
          code: 'CONSTRAINT'
        }
      };

    case '42P01': {
      const message = String(e.message || '');
      const match = message.match(
        /relation ["']([^"']+)["'] does not exist/i
      );

      const relation = match ? match[1] : null;

      console.error(
        '[postgres:42P01] Missing relation:',
        relation || 'unknown',
        message
      );

      return {
        status: 503,
        body: {
          error: relation
            ? 'Tabel/relasi belum ada: ' + relation +
              '. Periksa schema database GERDEV.'
            : 'Tabel belum ada. Periksa schema database GERDEV.',
          code: 'NOT_MIGRATED',
          missing_relation: relation
        }
      };
    }

    default:
      break;
  }

  console.error(
    '[error]',
    e && e.stack ? e.stack : e
  );

  return {
    status: 500,
    body: {
      error: 'Terjadi kesalahan pada server',
      code: 'INTERNAL'
    }
  };
}

module.exports = {
  HttpError,
  parseCookies,
  sendJson,
  readBody,
  createRouter,
  toErrorResponse,
  securityHeaders
};
      
