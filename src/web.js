'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateConfig, saveConfig } = require('./config');

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY = 1024 * 1024;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function sameSecret(a, b) {
  // Hash first so timingSafeEqual sees equal-length buffers regardless of input length.
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Status and the local data viewer are public; reading or changing the configuration
// needs a session token obtained with the UI password.
function createWebServer({ gateway, configFile, log }) {
  const sessions = new Map();

  function authorised(req) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const expires = sessions.get(token);
    if (!expires) return false;
    if (expires < Date.now()) {
      sessions.delete(token);
      return false;
    }
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    return true;
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
    }

    if (req.method === 'GET' && p === '/api/status') return send(res, 200, gateway.status());

    if (req.method === 'GET' && p === '/api/data') {
      const area = url.searchParams.get('area') === 'coils' ? 'coils' : 'holdings';
      const start = Math.min(65535, Math.max(0, parseInt(url.searchParams.get('start'), 10) || 0));
      const count = Math.min(500, Math.max(1, parseInt(url.searchParams.get('count'), 10) || 50), 65536 - start);
      return send(res, 200, { area, start, values: gateway.store.read(area, start, count) });
    }

    if (req.method === 'POST' && p === '/api/login') {
      const body = await readBody(req);
      if (!sameSecret(body.password ?? '', gateway.config.uiPassword)) {
        log(`Rejected configuration login from ${req.socket.remoteAddress}`);
        return send(res, 401, { error: 'Wrong password' });
      }
      const token = crypto.randomBytes(24).toString('hex');
      sessions.set(token, Date.now() + SESSION_TTL_MS);
      return send(res, 200, { token });
    }

    if (req.method === 'POST' && p === '/api/logout') {
      const header = req.headers.authorization || '';
      sessions.delete(header.replace(/^Bearer /, ''));
      return send(res, 200, { ok: true });
    }

    if (p === '/api/config') {
      if (!authorised(req)) return send(res, 401, { error: 'Login required' });
      if (req.method === 'GET') {
        const { uiPassword, ...rest } = gateway.config;
        return send(res, 200, rest);
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        // The password is not editable from the UI, so a save can never lock anyone out.
        const { config, errors } = validateConfig({ ...body, uiPassword: gateway.config.uiPassword });
        if (errors.length) return send(res, 400, { error: 'Invalid configuration', errors });
        const webPortChanged = config.web.port !== gateway.config.web.port;
        saveConfig(configFile, config);
        await gateway.apply(config);
        log(`Configuration saved from ${req.socket.remoteAddress}`);
        return send(res, 200, { ok: true, restartRequired: webPortChanged });
      }
    }

    send(res, 404, { error: 'Not found' });
  }

  return http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (!res.headersSent) send(res, 400, { error: err.message });
    });
  });
}

module.exports = { createWebServer };
