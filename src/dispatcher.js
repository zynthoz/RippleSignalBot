const Redis = require('ioredis');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatTicker(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (typeof t === 'object') {
    const symbol = String(t.symbol || t.SYMBOL || '').trim();
    const conviction = String(t.conviction || t.conviction_level || '').trim();
    if (!symbol) return '';
    return conviction ? `${symbol} (${conviction})` : symbol;
  }
  return String(t);
}

function toBullets(items) {
  if (!items.length) return '• N/A';
  return items.map((x) => `• ${escapeHtml(String(x))}`).join('\n');
}

function formatSignalMessage(obj) {
  const direction = String(obj.direction || 'NEUTRAL').toUpperCase();
  const emoji = direction === 'BULLISH' ? '🟢' : direction === 'BEARISH' ? '🔴' : direction === 'MIXED' ? '🟡' : '⚪';

  // Tickers: can be a JSON string or an already-parsed array of objects/strings
  const rawTickers = parseJsonArray(obj.tickers) || [];
  const normalizedTickers = (Array.isArray(rawTickers) ? rawTickers : [])
    .map((t) => {
      if (!t) return null;
      if (typeof t === 'string') return { symbol: String(t).trim().toUpperCase(), conviction: '' };
      return { symbol: String(t.symbol || t.SYMBOL || '').trim().toUpperCase(), conviction: String(t.conviction || t.conviction_level || '').trim() };
    })
    .filter(Boolean);

  const positivesArr = (parseJsonArray(obj.positively_affected) || []).map((s) => String(s).trim().toUpperCase());
  const negativesArr = (parseJsonArray(obj.negatively_affected) || []).map((s) => String(s).trim().toUpperCase());
  const positivesSet = new Set(positivesArr);
  const negativesSet = new Set(negativesArr);

  const longs = [];
  const shorts = [];
  const others = [];
  const conflicts = [];

  for (const t of normalizedTickers) {
    const sym = t.symbol || '';
    const line = formatTicker(t);
    if (!sym) continue;
    if (negativesSet.has(sym)) {
      shorts.push(line);
      if (positivesSet.has(sym)) conflicts.push(sym);
    } else if (positivesSet.has(sym)) {
      longs.push(line);
    } else {
      others.push(line);
    }
  }

  function horizonWithRange(h) {
    const key = String(h || '').toLowerCase();
    if (key.includes('intra')) return 'intraday (0-1 days)';
    if (key.includes('short')) return 'short-term (1-4 weeks)';
    if (key.includes('medium')) return 'medium-term (2-6 months)';
    if (key.includes('long')) return 'long-term (>6 months)';
    return String(h || 'short-term');
  }

  function numbered(items) {
    if (!items || items.length === 0) return 'N/A';
    return items.map((x, i) => `${i + 1}. ${escapeHtml(String(x))}`).join('\n');
  }

  const firstOrder = toBullets(parseJsonArray(obj.first_order_effects));
  const secondOrder = toBullets(parseJsonArray(obj.second_order_effects));

  const confidence = escapeHtml(obj.confidence || 'N/A');
  const horizon = horizonWithRange(obj.time_horizon);
  const headline = escapeHtml(obj.source_headline || 'Untitled');
  const rootCause = escapeHtml(obj.root_cause || obj.reasoning || 'N/A');
  const sourceAttribution = escapeHtml(obj.source_attribution || 'NewsAPI');
  const sourceName = escapeHtml(obj.source_name || 'NewsAPI');
  const sourceUrl = String(obj.source_url || '').trim();
  const geography = escapeHtml(obj.geography || 'unspecified');

  let sourceLine = sourceAttribution;
  if (sourceUrl) {
    sourceLine = `<a href="${escapeHtml(sourceUrl)}">${sourceName}</a> — <a href="${escapeHtml(sourceUrl)}">open</a>`;
  }

  const investmentThesis = escapeHtml(obj.investment_thesis || obj.investment_thesis || 'N/A');
  const thesisRisks = parseJsonArray(obj.thesis_risks || obj.thesis_risks) || [];
  const catalystChain = parseJsonArray(obj.catalyst_chain || obj.catalyst_chain) || [];

  const longLine = longs.length ? longs.map(escapeHtml).join(' · ') : 'N/A';
  const shortLine = shorts.length ? shorts.map(escapeHtml).join(' · ') : 'N/A';
  const othersLine = others.length ? others.map(escapeHtml).join(' · ') : '';

  const conflictNote = conflicts.length ? `\n⚠️ Conflict: ${conflicts.join(', ')} appears in both positive and negative lists; dispatcher prefers negative impact.` : '';

  const parts = [
    `${emoji} <b>${escapeHtml(direction)}</b> | ${confidence}% confidence | ${horizon}`,
    '',
    `📰 ${headline}`,
    '',
    '🎯 <b>Root Cause</b>',
    rootCause,
    '',
    '💡 <b>Thesis</b>',
    investmentThesis,
    '',
    '⚠️ <b>Risks</b>',
    thesisRisks.length ? thesisRisks.map((r) => `• ${escapeHtml(r)}`).join('\n') : '• N/A',
    '',
    `🌍 <b>Geography</b>: ${geography}`,
    '',
    '📈 <b>Long</b>',
    longLine,
    '',
    '📉 <b>Short</b>',
    shortLine,
  ];

  if (othersLine) {
    parts.push('', '📌 <b>Other tickers</b>', othersLine);
  }

  parts.push('', '⚡ <b>First Order</b>', firstOrder, '', '🔁 <b>Second Order</b>', secondOrder);

  parts.push('', '🔗 <b>Catalyst Chain</b>', catalystChain.length ? numbered(catalystChain) : 'N/A');

  parts.push('', `🗞 <b>Source:</b> ${sourceLine}`);

  if (conflictNote) parts.push('', conflictNote);

  return parts.join('\n');
}

async function matchWatchlistRules(pool, signalObj) {
  // Extract signal properties for matching
  const tickers = parseJsonArray(signalObj.tickers).map(t => {
    if (typeof t === 'string') return t.toUpperCase();
    if (typeof t === 'object' && t) return String(t.symbol || t.ticker || '').toUpperCase();
    return '';
  }).filter(Boolean);

  const direction = String(signalObj.direction || '').toUpperCase();
  const confidence = parseInt(signalObj.confidence, 10) || 0;
  const timeHorizon = String(signalObj.time_horizon || '').toLowerCase();

  if (tickers.length === 0) return { matchedUsers: [], noRuleUsers: [] };

  try {
    // Get all active watchlist rules
    const rulesRes = await pool.query(`
      SELECT w.id AS watchlist_id, w.user_id, w.ticker, w.direction, w.min_confidence, w.max_confidence,
             w.time_horizon, w.notify_telegram, w.notify_in_app,
             u.telegram_id
      FROM user_watchlist w
      JOIN users u ON w.user_id = u.id
      WHERE w.active = true AND u.subscribed = true
    `);

    // Group rules by user
    const userRules = {};
    for (const rule of rulesRes.rows) {
      if (!userRules[rule.user_id]) userRules[rule.user_id] = [];
      userRules[rule.user_id].push(rule);
    }

    // Users who want ALL signals (broadcast mode)
    const broadcastUsersRes = await pool.query(
      'SELECT id, telegram_id FROM users WHERE subscribed = true AND telegram_broadcast = true'
    );
    const noRuleUsers = broadcastUsersRes.rows.filter(u => u.telegram_id);

    // Match rules against signal
    const matchedUsers = []; // { user_id, telegram_id, watchlist_id, notify_telegram, notify_in_app }
    for (const [userId, rules] of Object.entries(userRules)) {
      for (const rule of rules) {
        const tickerMatch = tickers.includes(rule.ticker.toUpperCase());
        const directionMatch = !rule.direction || rule.direction === direction;
        const confMatch = confidence >= (rule.min_confidence || 0) && confidence <= (rule.max_confidence || 100);
        const horizonMatch = !rule.time_horizon || timeHorizon.includes(rule.time_horizon);

        if (tickerMatch && directionMatch && confMatch && horizonMatch) {
          matchedUsers.push({
            user_id: userId,
            telegram_id: rule.telegram_id,
            watchlist_id: rule.watchlist_id,
            notify_telegram: rule.notify_telegram,
            notify_in_app: rule.notify_in_app
          });
          break; // One match per user is enough
        }
      }
    }

    return { matchedUsers, noRuleUsers };
  } catch (err) {
    console.error('Dispatcher: watchlist matching error', err.message || err);
    return { matchedUsers: [], noRuleUsers: [] };
  }
}

async function startDispatcher({ pool, bot, redisUrl }) {
  if (!bot) {
    console.warn('Dispatcher: Telegram bot missing; dispatcher not started.');
    return;
  }

  const redis = new Redis(redisUrl);
  const STREAM = 'signals:ready';
  const GROUP = 'signal_dispatchers';
  const CONSUMER = `dispatcher-${Date.now()}`;

  try {
    await redis.xgroup('CREATE', STREAM, GROUP, '0', 'MKSTREAM');
    console.log(`Dispatcher: created consumer group ${GROUP}`);
  } catch (err) {
    if (!/BUSYGROUP/.test(String(err))) {
      console.warn('Dispatcher: xgroup create error', err.message || err);
    }
  }

  console.log('Dispatcher: listening for signals...');

  while (true) {
    try {
      const res = await redis.xreadgroup(
        'GROUP',
        GROUP,
        CONSUMER,
        'COUNT',
        1,
        'BLOCK',
        5000,
        'STREAMS',
        STREAM,
        '>'
      );
      if (!res) continue;

      for (const [stream, messages] of res) {
        for (const [id, fields] of messages) {
          try {
            const obj = {};
            for (let i = 0; i < fields.length; i += 2) {
              obj[fields[i]] = fields[i + 1];
            }

            const message = formatSignalMessage(obj);
            const signalId = obj.id || null;

            // Phase 2: Watchlist-aware dispatch
            const { matchedUsers, noRuleUsers } = await matchWatchlistRules(pool, obj);

            // Build combined Telegram recipient list
            const telegramRecipients = [];

            // Users without rules get all signals (broadcast)
            for (const u of noRuleUsers) {
              if (u.telegram_id) telegramRecipients.push(u.telegram_id);
            }

            // Users with matching watchlist rules
            for (const match of matchedUsers) {
              if (match.notify_telegram && match.telegram_id) {
                telegramRecipients.push(match.telegram_id);
              }

              // Insert in-app notification
              if (match.notify_in_app && signalId) {
                try {
                  await pool.query(
                    'INSERT INTO user_in_app_notifications (user_id, signal_id, watchlist_id) VALUES ($1, $2, $3)',
                    [match.user_id, signalId, match.watchlist_id]
                  );
                } catch (notifErr) {
                  console.warn('Dispatcher: failed to insert in-app notification', notifErr.message);
                }
              }
            }

            // Deduplicate telegram IDs
            const uniqueRecipients = [...new Set(telegramRecipients)];

            // Rate limiting config
            const batchSize = Number(process.env.DISPATCH_BATCH_SIZE || 20);
            const delayMs = Number(process.env.DISPATCH_DELAY_MS || 1000);

            for (let i = 0; i < uniqueRecipients.length; i += batchSize) {
              const batch = uniqueRecipients.slice(i, i + batchSize);

              await Promise.all(batch.map(async (tid) => {
                try {
                  await bot.telegram.sendMessage(tid, message, { parse_mode: 'HTML' });
                } catch (sendErr) {
                  if (sendErr && sendErr.response && sendErr.response.statusCode === 429) {
                    const retryAfter = (sendErr.response.body && sendErr.response.body.parameters && sendErr.response.body.parameters.retry_after) || 1;
                    console.warn('Dispatcher: rate limited, retrying after', retryAfter, 's');
                    await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
                    try { await bot.telegram.sendMessage(tid, message, { parse_mode: 'HTML' }); } catch (e) { console.warn('Dispatcher: failed after retry', e && e.message); }
                  } else {
                    console.warn('Dispatcher: failed to send to', tid, sendErr && sendErr.message);
                  }
                }
              }));

              if (i + batchSize < uniqueRecipients.length) await new Promise((r) => setTimeout(r, delayMs));
            }

            console.log(`Dispatcher: sent to ${uniqueRecipients.length} Telegram users (${matchedUsers.length} watchlist matches, ${noRuleUsers.length} broadcast)`);

            await redis.xack(STREAM, GROUP, id);
          } catch (procErr) {
            console.error('Dispatcher: message processing error', procErr.message || procErr);
            await redis.xack(STREAM, GROUP, id);
          }
        }
      }
    } catch (err) {
      console.error('Dispatcher error:', err.message || err);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

module.exports = { startDispatcher, formatSignalMessage };
