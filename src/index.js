const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');
const { Pool } = require('pg');
const Redis = require('ioredis');
require('dotenv').config();
const { poll: startNewsPoller } = require('./newsApi');

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN;
const WEBHOOK_PATH = '/webhook';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSignal(row) {
  const tickers = Array.isArray(row.tickers) ? row.tickers.join(', ') : 'N/A';
  const createdAt = row.created_at ? new Date(row.created_at).toISOString() : 'unknown';

  return [
    `${row.direction || 'NEUTRAL'} signal for ${tickers}`,
    `Confidence: ${row.confidence ?? 'N/A'}%`,
    `Time: ${createdAt}`,
    '',
    row.reasoning || 'No reasoning available yet.',
    '',
    `Source: ${row.source_url || 'unknown'}`,
  ].join('\n');
}

async function start() {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  if (!REDIS_URL) {
    throw new Error('REDIS_URL is required');
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  const redis = new Redis(REDIS_URL);
  let bot = null;

  await pool.query('SELECT 1');
  await redis.ping();

  if (TELEGRAM_BOT_TOKEN) {
    bot = new Telegraf(TELEGRAM_BOT_TOKEN);

    bot.start((ctx) => ctx.reply('MarketPulse AI is online. Use /help to see available commands.'));
    bot.help((ctx) => {
      ctx.reply('/start - welcome\n/subscribe - receive signals\n/unsubscribe - stop signals\n/latest - recent signals');
    });

    bot.command('subscribe', async (ctx) => {
      const telegramId = ctx.from?.id;
      const username = ctx.from?.username || null;

      await pool.query(
        `
          INSERT INTO users (telegram_id, username, subscribed)
          VALUES ($1, $2, true)
          ON CONFLICT (telegram_id)
          DO UPDATE SET username = EXCLUDED.username, subscribed = true
        `,
        [telegramId, username],
      );

      await ctx.reply('You are subscribed to MarketPulse AI signals.');
    });

    bot.command('unsubscribe', async (ctx) => {
      const telegramId = ctx.from?.id;

      await pool.query(
        `
          UPDATE users
          SET subscribed = false
          WHERE telegram_id = $1
        `,
        [telegramId],
      );

      await ctx.reply('You are unsubscribed from MarketPulse AI signals.');
    });

    bot.command('latest', async (ctx) => {
      const result = await pool.query(
        `
          SELECT tickers, direction, confidence, reasoning, source_url, created_at
          FROM signals
          ORDER BY created_at DESC
          LIMIT 5
        `,
      );

      if (result.rows.length === 0) {
        await ctx.reply('No signals have been stored yet.');
        return;
      }

      const message = result.rows
        .map((row, index) => `${index + 1}. ${formatSignal(row)}`)
        .join('\n\n---\n\n');

      await ctx.reply(escapeHtml(message), { parse_mode: 'HTML' });
    });
  }

  const webhookMiddleware = bot ? bot.webhookCallback(WEBHOOK_PATH) : null;

  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = requestUrl.pathname;

    function sendJson(statusCode, data) {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(200, { ok: true, bot: Boolean(bot) });
      return;
    }

    if (bot && req.method === 'POST' && pathname === WEBHOOK_PATH) {
      webhookMiddleware(req, res);
      return;
    }

    // Phase 2: REST API Routes
    if (req.method === 'GET' && pathname === '/api/signals') {
      try {
        const direction = requestUrl.searchParams.get('direction');
        const limit = parseInt(requestUrl.searchParams.get('limit') || '50', 10);
        const offset = parseInt(requestUrl.searchParams.get('offset') || '0', 10);

        let query = 'SELECT * FROM signals';
        const values = [];
        if (direction && direction !== 'ALL') {
          query += ' WHERE direction = $1';
          values.push(direction);
        }
        query += ` ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
        values.push(limit, offset);

        const result = await pool.query(query, values);
        sendJson(200, result.rows);
      } catch (err) {
        console.error('Error fetching signals:', err);
        sendJson(500, { error: 'Internal Server Error' });
      }
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/api/signals/')) {
      const id = pathname.split('/')[3];
      if (!id) return sendJson(400, { error: 'Missing ID' });
      
      try {
        const result = await pool.query('SELECT * FROM signals WHERE id = $1', [id]);
        if (result.rows.length === 0) {
          sendJson(404, { error: 'Signal not found' });
        } else {
          sendJson(200, result.rows[0]);
        }
      } catch (err) {
        console.error('Error fetching signal:', err);
        sendJson(500, { error: 'Internal Server Error' });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/stats') {
      try {
        const totalSignalsRes = await pool.query('SELECT COUNT(*) FROM signals');
        const subscribedUsersRes = await pool.query('SELECT COUNT(*) FROM users WHERE subscribed = true');
        const signalsTodayRes = await pool.query("SELECT COUNT(*) FROM signals WHERE created_at >= NOW() - INTERVAL '24 hours'");
        const lastSignalRes = await pool.query('SELECT created_at FROM signals ORDER BY created_at DESC LIMIT 1');

        sendJson(200, {
          total_signals: parseInt(totalSignalsRes.rows[0].count, 10),
          subscribed_users: parseInt(subscribedUsersRes.rows[0].count, 10),
          signals_today: parseInt(signalsTodayRes.rows[0].count, 10),
          last_signal_at: lastSignalRes.rows.length > 0 ? lastSignalRes.rows[0].created_at : null
        });
      } catch (err) {
        console.error('Error fetching stats:', err);
        sendJson(500, { error: 'Internal Server Error' });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write(': connected\n\n');

      const subRedis = new Redis(REDIS_URL);
      let isConnected = true;

      const pollEvents = async () => {
        let lastId = '$';
        while (isConnected) {
          try {
            const result = await subRedis.xread('BLOCK', 15000, 'STREAMS', 'signals:ready', lastId);
            if (result && isConnected) {
              for (const [stream, messages] of result) {
                for (const [id, fields] of messages) {
                  lastId = id;
                  const obj = {};
                  for (let i = 0; i < fields.length; i += 2) {
                    obj[fields[i]] = fields[i + 1];
                  }
                  if (isConnected) {
                    res.write(`data: ${JSON.stringify(obj)}\n\n`);
                  }
                }
              }
            }
          } catch (err) {
            console.error('SSE Redis error:', err);
            if (isConnected) await new Promise(r => setTimeout(r, 2000));
          }
        }
      };

      pollEvents();

      req.on('close', () => {
        isConnected = false;
        subRedis.quit();
      });
      return;
    }

    // Phase 3: Static File Serving
    if (req.method === 'GET') {
      let filePath = path.join(__dirname, '..', 'website', pathname === '/' ? 'index.html' : pathname);
      
      // Prevent directory traversal
      if (!filePath.startsWith(path.join(__dirname, '..', 'website'))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
          // SPA fallback or 404
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.svg': 'image/svg+xml',
          '.json': 'application/json'
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';

        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(filePath).pipe(res);
      });
      return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
  });

  server.listen(PORT, () => {
    void (async () => {
      console.log(`MarketPulse scaffold listening on http://localhost:${PORT}`);

      if (bot && WEBHOOK_DOMAIN) {
        const webhookUrl = `${WEBHOOK_DOMAIN.replace(/\/$/, '')}${WEBHOOK_PATH}`;
        await bot.telegram.setWebhook(webhookUrl, { drop_pending_updates: true });
        console.log(`Telegram webhook set to ${webhookUrl}`);
      } else if (bot) {
        console.warn('TELEGRAM_BOT_TOKEN is set but WEBHOOK_DOMAIN is missing; webhook was not registered.');
      } else {
        console.warn('TELEGRAM_BOT_TOKEN is missing; running in scaffold mode without Telegram webhook support.');
      }

          await startNewsPoller();

          // Start dispatcher to send signals to subscribed Telegram users
          try {
            const { startDispatcher } = require('./dispatcher');
            startDispatcher({ pool, bot, redisUrl: REDIS_URL });
            console.log('Signal dispatcher started');
          } catch (err) {
            console.warn('Failed to start dispatcher:', err.message || err);
          }
    })().catch((error) => {
      console.error('Failed to finish startup:', error);
      process.exit(1);
    });
  });

  async function shutdown(signal) {
    console.log(`${signal} received, shutting down...`);
    server.close();
    await Promise.allSettled([
      pool.end(),
      redis.quit(),
    ]);
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});