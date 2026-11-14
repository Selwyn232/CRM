'use strict';
// Robin Foundation CRM — HTTP-server zonder externe dependencies.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./src/db');
const { buildRoutes } = require('./src/api');
const { AppError } = require('./src/services');
const { parseCookies } = require('./src/auth');

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = process.env.CRM_UPLOADS || path.join(__dirname, 'data', 'uploads');
const MAX_BODY = 80 * 1024 * 1024; // 80 MB (uploads komen als base64 binnen)

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.pdf': 'application/pdf',
};

const PAGES = { '/': 'index.html', '/admin': 'admin.html', '/portal': 'portal.html', '/leaderboard': 'leaderboard.html', '/ontvanger': 'ontvanger.html' };

function compile(routes) {
  return routes.map(([method, pattern, handler, guard]) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    return { method, re, keys, handler, guard };
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new AppError(413, 'Verzoek te groot')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new AppError(400, 'Ongeldige JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    res.writeHead(status, headers);
    res.end(body);
  } else {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  }
}

function serveFile(req, res, file) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'Niet gevonden', { 'Content-Type': 'text/plain; charset=utf-8' });
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' };
    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    fs.createReadStream(file).pipe(res);
  });
}

function safeJoin(base, rel) {
  const target = path.normalize(path.join(base, rel));
  return target.startsWith(base + path.sep) ? target : null;
}

function createServer({ db, uploadDir = UPLOAD_DIR } = {}) {
  db = db || openDb();
  fs.mkdirSync(uploadDir, { recursive: true });
  const routes = compile(buildRoutes({ db, uploadDir }));

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    try {
      if (pathname.startsWith('/api/')) {
        const method = req.method.toUpperCase();
        let match = null;
        let params = {};
        for (const r of routes) {
          if (r.method !== method) continue;
          const m = r.re.exec(pathname);
          if (m) { match = r; r.keys.forEach((k, i) => { params[k] = m[i + 1]; }); break; }
        }
        if (!match) throw new AppError(404, 'Onbekend API-pad');
        if (method !== 'GET' && method !== 'HEAD') {
          const ct = req.headers['content-type'] || '';
          // Eenvoudige CSRF-bescherming: mutaties alleen met JSON (geen cross-site formulier-posts).
          if (!ct.includes('application/json')) throw new AppError(415, 'Content-Type moet application/json zijn');
        }
        const ctx = {
          req, res, params, url,
          query: Object.fromEntries(url.searchParams),
          cookies: parseCookies(req.headers.cookie),
          secure: req.headers['x-forwarded-proto'] === 'https',
          body: method === 'GET' ? {} : await readBody(req),
        };
        if (match.guard) match.guard(ctx);
        const out = await match.handler(ctx);
        if (out && out.__raw) return send(res, out.status || 200, out.body, out.headers);
        return send(res, 200, out === undefined ? { ok: true } : out, ctx.headers || {});
      }

      if (pathname.startsWith('/uploads/')) {
        const file = safeJoin(uploadDir, pathname.slice('/uploads/'.length));
        if (!file) return send(res, 404, 'Niet gevonden');
        return serveFile(req, res, file);
      }
      const page = PAGES[pathname.replace(/\/$/, '') || '/'];
      const file = page ? path.join(PUBLIC_DIR, page) : safeJoin(PUBLIC_DIR, pathname);
      if (!file) return send(res, 404, 'Niet gevonden');
      return serveFile(req, res, file);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Er ging iets mis op de server' : err.message });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const db = openDb();
  const { get } = require('./src/db');
  if (!get(db, 'SELECT id FROM users LIMIT 1')) {
    console.log('Lege database gedetecteerd — demodata wordt geladen…');
    require('./src/seed').seed(db);
  }
  createServer({ db }).listen(port, () => {
    console.log(`Robin Foundation CRM draait op http://localhost:${port}`);
    console.log(`  Beheer:          http://localhost:${port}/admin`);
    console.log(`  Donateursportaal: http://localhost:${port}/portal`);
    console.log(`  Leaderboard:     http://localhost:${port}/leaderboard`);
    console.log(`  Ontvangers:      http://localhost:${port}/ontvanger`);
  });
}

module.exports = { createServer };
