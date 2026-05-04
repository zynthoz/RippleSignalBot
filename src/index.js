const http = require('http');
const { URL } = require('url');
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

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && requestUrl.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bot: Boolean(bot) }));
      return;
    }

    if (bot && req.method === 'POST' && requestUrl.pathname === WEBHOOK_PATH) {
      webhookMiddleware(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
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