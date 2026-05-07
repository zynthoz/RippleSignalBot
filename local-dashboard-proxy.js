const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 4173);
const UPSTREAM_API_URL = String(process.env.NGROK_API_URL || process.env.API_BASE_URL || '').trim().replace(/\/$/, '');
const WEBSITE_DIR = path.join(__dirname, 'website');

if (!UPSTREAM_API_URL) {
  console.error('NGROK_API_URL is required, for example: NGROK_API_URL=https://your-tunnel.ngrok-free.app npm run proxy');
  process.exit(1);
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.map': 'application/json; charset=utf-8',
  }[ext] || 'application/octet-stream';
}

function sendFile(res, filePath) {
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    res.writeHead(200, { 'Content-Type': getContentType(filePath) });
    fs.createReadStream(filePath).pipe(res);
  });
}

function proxyToNgrok(req, res) {
  const upstreamUrl = new URL(req.url, UPSTREAM_API_URL);
  const client = upstreamUrl.protocol === 'https:' ? https : http;
  const headers = { ...req.headers };
  headers.host = upstreamUrl.host;
  headers['ngrok-skip-browser-warning'] = 'true';

  const proxyReq = client.request(
    upstreamUrl,
    {
      method: req.method,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (error) => {
    console.error('Proxy error:', error.message || error);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end('Bad Gateway');
  });

  req.on('aborted', () => proxyReq.destroy());
  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;

  if (pathname.startsWith('/api/')) {
    proxyToNgrok(req, res);
    return;
  }

  if (pathname === '/' || pathname === '/dashboard') {
    sendFile(res, path.join(WEBSITE_DIR, 'index.html'));
    return;
  }

  const safePath = path.normalize(path.join(WEBSITE_DIR, pathname));
  if (!safePath.startsWith(WEBSITE_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  sendFile(res, safePath);
});

server.listen(PORT, () => {
  console.log(`Dashboard proxy running at http://localhost:${PORT}`);
  console.log(`Forwarding /api/* to ${UPSTREAM_API_URL}`);
});
