// serve.js — zero-dependency static file server for WhatfxConvert
// Usage: node serve.js  (or: node serve.js 3000)

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT      = parseInt(process.argv[2] || process.env.PORT || '3000', 10);
const PUBLIC    = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.json': 'application/json',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
};

const server = http.createServer((req, res) => {
  // Sanitise path — prevent directory traversal
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const abs = path.join(PUBLIC, path.normalize(urlPath));
  if (!abs.startsWith(PUBLIC)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    // SPA fallback
    const idx = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(idx).pipe(res);
    return;
  }

  const ext  = path.extname(abs).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(abs).pipe(res);
});

server.listen(PORT, () => {
  console.log(`\n  WhatfxConvert (static) → http://localhost:${PORT}\n`);
});
