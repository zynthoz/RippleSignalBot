const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');
const { Pool } = require('pg');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
require('dotenv').config();
const { poll: startNewsPoller } = require('./newsApi');
const { createRedisClient } = require('./redisClient');

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
  const redis = createRedisClient(REDIS_URL);
  let bot = null;

  await pool.query('SELECT 1');
  await redis.ping();

  if (TELEGRAM_BOT_TOKEN) {
    bot = new Telegraf(TELEGRAM_BOT_TOKEN);

    bot.start((ctx) => {
      console.log('Command: /start');
      return ctx.reply('MarketPulse AI is online. Use /help to see available commands.');
    });
    bot.help((ctx) => {
      console.log('Command: /help');
      ctx.reply('/start - welcome\n/linktelegram <code> - link your website account\n/broadcast <on|off> - toggle receiving all signals vs watchlist only\n/subscribe - receive signals\n/unsubscribe - stop signals\n/latest - recent signals');
    });

    bot.catch((err, ctx) => {
      console.error(`Telegraf error for ${ctx.updateType}`, err);
    });

    bot.command('linktelegram', async (ctx) => {
      console.log('Command: /linktelegram');
      const code = (ctx.message.text.split(' ')[1] || '').trim().toUpperCase();
      if (!code) {
        return ctx.reply('Please provide your link code. Example: /linktelegram ABCDEF');
      }

      const telegramId = ctx.from?.id;
      const username = ctx.from?.username || null;

      try {
        // First, clean up any existing bot-only row for this telegram_id 
        // to avoid unique constraint violations when linking the web account
        await pool.query(
          'DELETE FROM users WHERE telegram_id = $1 AND telegram_link_code IS NULL',
          [telegramId]
        );

        const result = await pool.query(
          'UPDATE users SET telegram_id = $1, username = $2, subscribed = true WHERE telegram_link_code = $3 RETURNING id, display_name',
          [telegramId, username, code]
        );

        if (result.rowCount === 0) {
          return ctx.reply('Invalid link code. Please check the website and try again.');
        }

        const user = result.rows[0];
        await ctx.reply(`Success! Your Telegram account is now linked to your MarketPulse AI profile (${user.display_name}).\n\nBy default, you will receive all signals. Use /broadcast off to only receive signals that match your website watchlist.`);
      } catch (err) {
        console.error('Error linking telegram:', err);
        ctx.reply('An error occurred while linking your account. Please try again.');
      }
    });

    bot.command('broadcast', async (ctx) => {
      console.log('Command: /broadcast');
      const telegramId = ctx.from?.id;
      const args = ctx.message.text.split(' ');
      const mode = (args[1] || '').toLowerCase();

      if (mode === 'on') {
        await pool.query('UPDATE users SET telegram_broadcast = true WHERE telegram_id = $1', [telegramId]);
        return ctx.reply('Broadcast ON: You will receive all MarketPulse AI signals.');
      } else if (mode === 'off') {
        await pool.query('UPDATE users SET telegram_broadcast = false WHERE telegram_id = $1', [telegramId]);
        return ctx.reply('Broadcast OFF: You will only receive signals that match your website watchlist.');
      } else {
        return ctx.reply('Please specify on or off. Example: /broadcast off');
      }
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

  const webhookMiddleware = bot ? bot.webhookCallback() : null;

  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, ngrok-skip-browser-warning');

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
      console.log('Incoming Telegram webhook update...');
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const update = JSON.parse(body);
          await bot.handleUpdate(update);
          res.writeHead(200);
          res.end('OK');
        } catch (err) {
          console.error('Error handling Telegram update:', err);
          res.writeHead(500);
          res.end('Error');
        }
      });
      return;
    }

    // Phase 2: REST API Routes
    if (req.method === 'GET' && pathname === '/api/signals') {
      try {
        const direction = requestUrl.searchParams.get('direction');
        const limit = parseInt(requestUrl.searchParams.get('limit') || '50', 10);
        const offset = parseInt(requestUrl.searchParams.get('offset') || '0', 10);

        let query = `
          SELECT s.*, 
            COALESCE(
              (SELECT json_agg(row_to_json(sp)) 
               FROM signal_performance sp 
               WHERE sp.signal_id = s.id), 
            '[]') as performance
          FROM signals s
        `;
        const values = [];
        if (direction && direction !== 'ALL') {
          query += ' WHERE s.direction = $1';
          values.push(direction);
        }
        query += ` ORDER BY s.created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
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
        const result = await pool.query(`
          SELECT s.*, 
            COALESCE(
              (SELECT json_agg(row_to_json(sp)) 
               FROM signal_performance sp 
               WHERE sp.signal_id = s.id), 
            '[]') as performance
          FROM signals s
          WHERE s.id = $1
        `, [id]);
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

      const subRedis = createRedisClient(REDIS_URL);
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

    // ============================================================
    // Helpers for JSON body parsing & session auth
    // ============================================================
    function parseBody() {
      return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => {
          try { resolve(data ? JSON.parse(data) : {}); }
          catch { reject(new Error('Invalid JSON')); }
        });
        req.on('error', reject);
      });
    }

    async function authenticateRequest() {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace('Bearer ', '').trim();
      if (!token) return null;
      const result = await pool.query(
        'SELECT id, email, display_name, telegram_id, telegram_link_code FROM users WHERE session_token = $1',
        [token]
      );
      return result.rows.length > 0 ? result.rows[0] : null;
    }

    // ============================================================
    // Auth APIs
    // ============================================================

    // POST /api/auth/register
    if (req.method === 'POST' && pathname === '/api/auth/register') {
      try {
        const body = await parseBody();
        const { email, password, display_name } = body;
        if (!email || !password) return sendJson(400, { error: 'Email and password are required' });
        if (password.length < 6) return sendJson(400, { error: 'Password must be at least 6 characters' });

        // Check if email already exists
        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) return sendJson(409, { error: 'Email already registered' });

        const passwordHash = await bcrypt.hash(password, 10);
        const sessionToken = crypto.randomBytes(32).toString('hex');
        const telegramLinkCode = crypto.randomBytes(4).toString('hex').toUpperCase();

        const result = await pool.query(
          `INSERT INTO users (email, password_hash, display_name, session_token, authenticated_at, telegram_link_code, subscribed)
           VALUES ($1, $2, $3, $4, NOW(), $5, true) RETURNING id, email, display_name, telegram_link_code`,
          [email, passwordHash, display_name || email.split('@')[0], sessionToken, telegramLinkCode]
        );

        sendJson(201, { user: result.rows[0], session_token: sessionToken });
      } catch (err) {
        console.error('Register error:', err);
        sendJson(500, { error: 'Internal Server Error' });
      }
      return;
    }

    // POST /api/auth/login
    if (req.method === 'POST' && pathname === '/api/auth/login') {
      try {
        const body = await parseBody();
        const { email, password } = body;
        if (!email || !password) return sendJson(400, { error: 'Email and password are required' });

        const result = await pool.query('SELECT id, email, display_name, password_hash, telegram_id, telegram_link_code FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) return sendJson(401, { error: 'Invalid credentials' });

        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return sendJson(401, { error: 'Invalid credentials' });

        const sessionToken = crypto.randomBytes(32).toString('hex');
        await pool.query('UPDATE users SET session_token = $1, authenticated_at = NOW() WHERE id = $2', [sessionToken, user.id]);

        sendJson(200, {
          user: { id: user.id, email: user.email, display_name: user.display_name, telegram_id: user.telegram_id, telegram_link_code: user.telegram_link_code },
          session_token: sessionToken
        });
      } catch (err) {
        console.error('Login error:', err);
        sendJson(500, { error: 'Internal Server Error' });
      }
      return;
    }

    // GET /api/auth/me
    if (req.method === 'GET' && pathname === '/api/auth/me') {
      try {
        const user = await authenticateRequest();
        if (!user) return sendJson(401, { error: 'Not authenticated' });
        sendJson(200, { user });
      } catch (err) {
        console.error('Auth me error:', err);
        sendJson(500, { error: 'Internal Server Error' });
      }
      return;
    }

    // POST /api/auth/logout
    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      try {
        const user = await authenticateRequest();
        if (user) {
          await pool.query('UPDATE users SET session_token = NULL WHERE id = $1', [user.id]);
        }
        sendJson(200, { ok: true });
      } catch (err) {
        console.error('Logout error:', err);
        sendJson(500, { error: 'Internal Server Error' });
      }
      return;
    }

    // ============================================================
    // Watchlist APIs
    // ============================================================

    // GET /api/watchlist
    if (req.method === 'GET' && pathname === '/api/watchlist') {
      try {
        const user = await authenticateRequest();
        if (!user) return sendJson(401, { error: 'Not authenticated' });
        const result = await pool.query(
          'SELECT * FROM user_watchlist WHERE user_id = $1 AND active = true ORDER BY created_at DESC',
          [user.id]
        );
        sendJson(200, result.rows);
      } catch (err) {
        console.error('Watchlist fetch error:', err);
        sendJson(500, { error: 'Internal Server Error' });
      }
      return;
    }

    // POST /api/watchlist
    if (req.method === 'POST' && pathname === '/api/watchlist') {
      try {
        const user = await authenticateRequest();
        if (!user) return sendJson(401, { error: 'Not authenticated' });
        const body = await parseBody();
        const { ticker, direction, min_confidence, max_confidence, time_horizon, source_quality, notify_telegram, notify_in_app, name } = body;
        if (!ticker) return sendJson(400, { error: 'Ticker is required' });

        // Enforce limit of 20 rules per user
        const countRes = await pool.query('SELECT COUNT(*) FROM user_watchlist WHERE user_id = $1 AND active = true', [user.id]);
        if (parseInt(countRes.rows[0].count, 10) >= 20) return sendJson(400, { error: 'Maximum 20 watchlist rules allowed' });

        const result = await pool.query(
          `INSERT INTO user_watchlist (user_id, ticker, direction, min_confidence, max_confidence, time_horizon, source_quality, notify_telegram, notify_in_app, name)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [user.id, ticker.toUpperCase(), direction || null, min_confidence || 0, max_confidence || 100,
           time_horizon || null, source_quality || null, notify_telegram !== false, notify_in_app !== false, name || null]
        );
        sendJson(201, result.rows[0]);
      } catch (err) {
        console.error('Watchlist create error:', err);
        sendJson(500, { error: 'Internal Server Error' });
      }
      return;
    }

    // PUT /api/watchlist/:id
    if (req.method === 'PUT' && pathname.startsWith('/api/watchlist/')) {
      const watchlistId = pathname.split('/')[3];
      if (!watchlistId) return sendJson(400, { error: 'Missing ID' });
      try {
        const user = await authenticateRequest();
        if (!user) return sendJson(401, { error: 'Not authenticated' });
        const body = await parseBody();

        // Build dynamic UPDATE
        const allowed = ['name', 'ticker', 'direction', 'min_confidence', 'max_confidence', 'time_horizon', 'source_quality', 'notify_telegram', 'notify_in_app', 'active'];
        const sets = [];
        const vals = [];
        let idx = 1;
        for (const key of allowed) {
          if (body[key] !== undefined) {
            sets.push(`${key} = $${idx++}`);
            vals.push(key === 'ticker' ? String(body[key]).toUpperCase() : body[key]);
          }
        }
        if (sets.length === 0) return sendJson(400, { error: 'No fields to update' });
        sets.push(`updated_at = NOW()`);
        vals.push(watchlistId, user.id);

        const result = await pool.query(
          `UPDATE user_watchlist SET ${sets.join(', ')} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
          vals
        );
        if (result.rows.length === 0) return sendJson(404, { error: 'Watchlist item not found' });
        sendJson(200, result.rows[0]);
      } catch (err) {
        console.error('Watchlist update error:', err);
        sendJson(500, { error: 'Internal Server Error' });
      }
      return;
    }

    // DELETE /api/watchlist/:id
    if (req.method === 'DELETE' && pathname.startsWith('/api/watchlist/')) {
      const watchlistId = pathname.split('/')[3];
      if (!watchlistId) return sendJson(400, { error: 'Missing ID' });
      try {
        const user = await authenticateRequest();
        if (!user) return sendJson(401, { error: 'Not authenticated' });
        const result = await pool.query(
          'UPDATE user_watchlist SET active = false, updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING id',
          [watchlistId, user.id]
        );
        if (result.rows.length === 0) return sendJson(404, { error: 'Watchlist item not found' });
        sendJson(200, { ok: true });
      } catch (err) {
        console.error('Watchlist delete error:', err);
        sendJson(500, { error: 'Internal Server Error' });
      }
      return;
    }

    // ============================================================
    // Notification APIs
    // ============================================================

    // GET /api/notifications
    if (req.method === 'GET' && pathname === '/api/notifications') {
      try {
        const user = await authenticateRequest();
        if (!user) return sendJson(401, { error: 'Not authenticated' });

        const unreadOnly = requestUrl.searchParams.get('unread') === 'true';
        const limit = parseInt(requestUrl.searchParams.get('limit') || '20', 10);
        const countOnly = requestUrl.searchParams.get('count') === 'true';

        if (countOnly) {
          const countRes = await pool.query(
            'SELECT COUNT(*) FROM user_in_app_notifications WHERE user_id = $1 AND read = false',
            [user.id]
          );
          return sendJson(200, { unread_count: parseInt(countRes.rows[0].count, 10) });
        }

        let query = `
          SELECT n.id, n.signal_id, n.watchlist_id, n.read, n.created_at,
                 s.tickers, s.direction, s.confidence, s.source_headline, s.root_cause
          FROM user_in_app_notifications n
          JOIN signals s ON n.signal_id = s.id
          WHERE n.user_id = $1
        `;
        const vals = [user.id];
        if (unreadOnly) {
          query += ' AND n.read = false';
        }
        query += ` ORDER BY n.created_at DESC LIMIT $${vals.length + 1}`;
        vals.push(limit);

        const result = await pool.query(query, vals);
        sendJson(200, result.rows);
      } catch (err) {
        console.error('Notifications fetch error:', err);
        sendJson(500, { error: 'Internal Server Error' });
      }
      return;
    }

    // POST /api/notifications/:id/read
    if (req.method === 'POST' && pathname.match(/^\/api\/notifications\/[^/]+\/read$/)) {
      const notifId = pathname.split('/')[3];
      try {
        const user = await authenticateRequest();
        if (!user) return sendJson(401, { error: 'Not authenticated' });
        await pool.query(
          'UPDATE user_in_app_notifications SET read = true WHERE id = $1 AND user_id = $2',
          [notifId, user.id]
        );
        sendJson(200, { ok: true });
      } catch (err) {
        console.error('Mark read error:', err);
        sendJson(500, { error: 'Internal Server Error' });
      }
      return;
    }

    // POST /api/notifications/read-all
    if (req.method === 'POST' && pathname === '/api/notifications/read-all') {
      try {
        const user = await authenticateRequest();
        if (!user) return sendJson(401, { error: 'Not authenticated' });
        await pool.query(
          'UPDATE user_in_app_notifications SET read = true WHERE user_id = $1 AND read = false',
          [user.id]
        );
        sendJson(200, { ok: true });
      } catch (err) {
        console.error('Mark all read error:', err);
        sendJson(500, { error: 'Internal Server Error' });
      }
      return;
    }

    // Root route → landing page
    if (req.method === 'GET' && pathname === '/') {
      const landingPath = path.join(__dirname, '..', 'website', 'landing.html');
      fs.stat(landingPath, (err, stats) => {
        if (err || !stats.isFile()) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        fs.createReadStream(landingPath).pipe(res);
      });
      return;
    }

    // Dashboard route → main app
    if (req.method === 'GET' && pathname === '/dashboard') {
      const dashPath = path.join(__dirname, '..', 'website', 'index.html');
      fs.stat(dashPath, (err, stats) => {
        if (err || !stats.isFile()) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        fs.createReadStream(dashPath).pipe(res);
      });
      return;
    }

    // Phase 3: Static File Serving (assets: js, css, png, etc.)
    if (req.method === 'GET') {
      let filePath = path.join(__dirname, '..', 'website', pathname);
      
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
        try {
          const webhookUrl = `${WEBHOOK_DOMAIN.replace(/\/$/, '')}${WEBHOOK_PATH}`;
          await bot.telegram.setWebhook(webhookUrl, { drop_pending_updates: true });
          console.log(`Telegram webhook set to ${webhookUrl}`);
        } catch (webhookErr) {
          console.error('Failed to set Telegram webhook:', webhookErr.message);
        }
      } else if (bot) {
        console.warn('TELEGRAM_BOT_TOKEN is set but WEBHOOK_DOMAIN is missing; webhook was not registered.');
      } else {
        console.warn('TELEGRAM_BOT_TOKEN is missing; running in scaffold mode without Telegram support.');
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