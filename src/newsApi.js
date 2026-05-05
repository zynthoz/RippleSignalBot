const axios = require('axios');
const crypto = require('crypto');
const Redis = require('ioredis');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const REDIS_URL = process.env.REDIS_URL;
const POLL_INTERVAL_MS = 60000; // 60 seconds
const MAX_ARTICLE_AGE_HOURS = 72; // Only consider articles from the last 72 hours (3 days)

// Centralized config object — change batch size here
const CONFIG = {
  batchSize: parseInt(process.env.NEWS_BATCH_SIZE || '20', 10),
  dedupeEnabled: process.env.NEWS_DEDUPE_ENABLED !== 'false',
  seenTtlSeconds: parseInt(process.env.NEWS_SEEN_TTL_SECONDS || '86400', 10),
  pendingTtlSeconds: parseInt(process.env.NEWS_PENDING_TTL_SECONDS || '900', 10),
};

const redis = new Redis(REDIS_URL);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite-preview' });

function hash(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

function getFingerprintBase(article) {
  return article.url
    || article.source_url
    || `${article.title || article.source_headline || ''}|${article.publishedAt || article.created_at || ''}`;
}

function getSeenKey(article) {
  const base = getFingerprintBase(article);
  return `article:${hash(base)}`;
}

function getPendingKey(article) {
  return `${getSeenKey(article)}:pending`;
}

// Redis-backed recurring/seen checker so repeated polls don't republish the same story.
// Returns { seen: boolean, reason: string, key: string }
async function checkIfSeen(article) {
  const key = getSeenKey(article);
  const pendingKey = getPendingKey(article);
  if (!CONFIG.dedupeEnabled) {
    return { seen: false, reason: 'dedupe disabled', key, pendingKey };
  }

  const [cached, pending] = await Promise.all([redis.get(key), redis.get(pendingKey)]);
  if (cached) {
    return { seen: true, reason: 'already processed in Redis cache', key, pendingKey };
  }

  if (pending) {
    return { seen: true, reason: 'currently pending processing', key, pendingKey };
  }

  return { seen: false, reason: 'new article', key, pendingKey };
}

async function markAsPending(article, keyFromCheck) {
  if (!CONFIG.dedupeEnabled) return;
  const key = keyFromCheck || getPendingKey(article);
  await redis.setex(key, CONFIG.pendingTtlSeconds, '1');
}

async function markAsSeen(payload, keyFromCheck) {
  if (!CONFIG.dedupeEnabled) return;
  const key = keyFromCheck || getSeenKey(payload);
  const pendingKey = getPendingKey(payload);
  await redis.setex(key, CONFIG.seenTtlSeconds, '1');
  await redis.del(pendingKey);
}

async function backfillProcessedSignals() {
  if (!CONFIG.dedupeEnabled) return;

  try {
    const recentMessages = await redis.xrevrange('signals:ready', '+', '-', 'COUNT', 200);
    for (const [, fields] of recentMessages) {
      const payload = {};
      for (let i = 0; i < fields.length; i += 2) {
        payload[fields[i]] = fields[i + 1];
      }
      if (payload.source_url || payload.source_headline) {
        await markAsSeen(payload);
      }
    }
  } catch (error) {
    console.warn(`Failed to backfill processed signals cache: ${error.message}`);
  }
}

async function trackProcessedSignals(trackerRedis) {
  let lastId = '$';

  while (true) {
    try {
      const result = await trackerRedis.xread('BLOCK', 15000, 'STREAMS', 'signals:ready', lastId);
      if (!result) continue;

      for (const [, messages] of result) {
        for (const [id, fields] of messages) {
          lastId = id;
          const payload = {};
          for (let i = 0; i < fields.length; i += 2) {
            payload[fields[i]] = fields[i + 1];
          }

          if (payload.source_url || payload.source_headline) {
            await markAsSeen(payload);
          }
        }
      }
    } catch (error) {
      console.warn(`Processed-signal tracker error: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

function buildRelevancePrompt(article) {
  return [
    'You are judging whether a news article is relevant to public markets.',
    'Mark relevant=true only if the story could materially affect stocks, ETFs, sectors, commodities, rates, macro policy, or public-company valuations within the next few days or weeks.',
    'Mark relevant=false only if the story is mostly local, human-interest, entertainment, sports, lifestyle, or otherwise unlikely to matter for public markets.',
    'Return a single JSON object with keys relevant (boolean), reason (short string), and confidence (0-100 integer).',
    'Do not include markdown, code fences, or extra commentary.',
    '',
    `Title: ${article.title || ''}`,
    `Description: ${article.description || ''}`,
    `Source: ${article.source || ''}`,
  ].join('\n');
}

async function aiJudgeRelevance(article) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not set');
  }

  const prompt = buildRelevancePrompt(article);
  const result = await geminiModel.generateContent(prompt);
  const text = (result?.response?.text?.() || result?.response?.text || '').trim();

  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  const candidate = jsonStart !== -1 && jsonEnd !== -1 ? text.slice(jsonStart, jsonEnd + 1) : text;

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new Error(`AI relevance judge returned invalid JSON: ${candidate.slice(0, 200)}`);
  }

  const relevant = Boolean(parsed.relevant);
  const reason = String(parsed.reason || (relevant ? 'AI judged article as market-relevant' : 'AI judged article as not market-relevant')).trim();
  const confidence = Math.max(0, Math.min(100, Number.parseInt(parsed.confidence ?? '50', 10) || 50));

  return { relevant, reason, confidence };
}

function levenshteinDistance(a, b) {
  const map = [];
  for (let i = 0; i <= b.length; i++) {
    map[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    map[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const indicator = a[j - 1] === b[i - 1] ? 0 : 1;
      map[i][j] = Math.min(map[i][j - 1] + 1, map[i - 1][j] + 1, map[i - 1][j - 1] + indicator);
    }
  }
  return map[b.length][a.length];
}

function similarity(a, b) {
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function isSimilarTitle(title1, title2, threshold = 0.75) {
  const normalized1 = title1.toLowerCase().trim();
  const normalized2 = title2.toLowerCase().trim();
  return similarity(normalized1, normalized2) > threshold;
}

async function extractEventDate(article) {
  // For now, skip the expensive Gemini call and just use the published date
  // Phase 3 (the AI worker) will do deeper analysis of content
  return new Date(article.publishedAt);
}

function isRecentEvent(eventDate) {
  if (!eventDate) return false;
  const now = new Date();
  const ageHours = (now - eventDate) / (1000 * 60 * 60);
  return ageHours >= 0 && ageHours <= MAX_ARTICLE_AGE_HOURS;
}

async function fetchNews() {
  if (!NEWS_API_KEY) {
    console.warn('NEWS_API_KEY not set; skipping news fetch');
    return [];
  }

  try {
    const response = await axios.get('https://newsapi.org/v2/top-headlines', {
      params: {
        apiKey: NEWS_API_KEY,
        category: 'business',
        sortBy: 'publishedAt',
        pageSize: 50,
      },
      timeout: 10000,
    });

    const rawArticles = response.data.articles || [];
    console.log(`API returned ${rawArticles.length} articles`);

    const articles = [];
    for (const article of rawArticles) {
      console.log(`Analyzing: ${article.title}`);
      const eventDate = await extractEventDate(article);

      if (!eventDate) {
        console.log(`  → Could not extract event date, skipping`);
        continue;
      }

      if (!isRecentEvent(eventDate)) {
        console.log(`  → Event date: ${eventDate.toISOString()} (too old, skipping)`);
        continue;
      }

      console.log(`  → Event date: ${eventDate.toISOString()} (recent, keeping)`);
      articles.push({
        title: article.title,
        description: article.description,
        url: article.url,
        source: article.source?.name || 'unknown',
        publishedAt: article.publishedAt,
        eventDate: eventDate.toISOString(),
        image: article.urlToImage,
      });
    }

    console.log(`After event date filtering: ${articles.length} articles`);
    return articles;
  } catch (error) {
    console.error(`Failed to fetch news: ${error.message}`);
    return [];
  }
}


// Determine whether an article is market-relevant.
// Returns { relevant: boolean, reason: string, confidence: number }
async function isMarketRelevant(article) {
  try {
    return await aiJudgeRelevance(article);
  } catch (error) {
    console.warn(`AI relevance judge failed, using conservative fallback: ${error.message}`);

    const text = `${article.title || ''} ${article.description || ''} ${article.source || ''}`.toLowerCase();
    const hasCompanyName = /\b(meta|alphabet|google|microsoft|apple|amazon|tesla|nvidia|meta\b|microsoft\b|openai|boeing|walmart|costco|target|intel|amd|uber|lyft|netflix|bank of america|jpmorgan|goldman sachs|blackrock)\b/i.test(text);
    const hasMarketContext = /\b(earnings|revenue|profit|guidance|regulation|lawsuit|court|antitrust|merger|acquisition|bankruptcy|rate|inflation|cpi|gdp|tariff|sanction|contract|order|shipment|supply chain)\b/i.test(text);

    if (hasCompanyName || hasMarketContext) {
      return { relevant: true, reason: 'fallback matched market-moving company or event context', confidence: 45 };
    }

    return { relevant: false, reason: 'fallback found no clear market-moving context', confidence: 35 };
  }
}

async function dedupAndPublish(articles) {
  let published = 0;
  const seenTitles = [];

  for (const article of articles) {
    // Stop when batch size reached
    if (published >= CONFIG.batchSize) {
      console.log(`Batch size ${CONFIG.batchSize} reached; skipping remaining ${articles.length - published} articles`);
      break;
    }

    let seenCheck = null;

    // Cheap duplicate gate first: skip stories already processed or already in-flight.
    try {
      seenCheck = await checkIfSeen(article);
      if (seenCheck.seen) {
        console.log(`Skipping duplicate (${seenCheck.reason}): ${article.title}`);
        continue;
      }
    } catch (err) {
      console.warn('Duplicate check failed, allowing article through:', err && err.message);
    }

    // Semantic deduplication (same story, different reporter) within this poll.
    const isDuplicate = seenTitles.some((seenTitle) => isSimilarTitle(article.title, seenTitle));
    if (isDuplicate) {
      console.log(`Skipping duplicate (same story, different reporter): ${article.title}`);
      continue;
    }

    // AI relevance gate: only spend Gemini tokens on stories that are still candidates.
    try {
      const { relevant, reason, confidence } = await isMarketRelevant(article);
      if (!relevant) {
        console.log(`Skipping not market-relevant (${reason}): ${article.title}`);
        await markAsSeen(article, seenCheck.key);
        continue;
      }

      seenTitles.push(article.title);
      await redis.xadd('news:raw', '*', 'article', JSON.stringify(article));
      await markAsPending(article, seenCheck.pendingKey);
      console.log(`Published: ${article.title} (relevance confidence ${confidence}%)`);
      published++;
    } catch (error) {
      console.error(`Failed to publish article "${article.title}": ${error.message}`);
    }
  }

  return published;
}

async function poll() {
  console.log('Starting news poller...');
  const trackerRedis = new Redis(REDIS_URL);

  const pollOnce = async () => {
    try {
      const articles = await fetchNews();

      if (articles.length === 0) {
        console.log('No articles fetched; waiting for next poll...');
        return;
      }

      console.log(`Fetched ${articles.length} articles`);
      const published = await dedupAndPublish(articles);
      console.log(`Published ${published} new articles to news:raw`);
    } catch (error) {
      console.error(`Poller error: ${error.message}`);
    }
  };

  await backfillProcessedSignals();

  trackProcessedSignals(trackerRedis);

  // Run immediately on startup
  await pollOnce();

  // Then schedule recurring polls
  setInterval(pollOnce, POLL_INTERVAL_MS);
}

module.exports = { poll };
