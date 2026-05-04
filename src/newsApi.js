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
  dedupeEnabled: process.env.NEWS_DEDUPE_ENABLED !== 'true',
  seenTtlSeconds: parseInt(process.env.NEWS_SEEN_TTL_SECONDS || '86400', 10),
};

const redis = new Redis(REDIS_URL);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite-preview' });

function hash(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

function getSeenKey(article) {
  const base = article.url || `${article.title || ''}|${article.publishedAt || ''}`;
  return `article:${hash(base)}`;
}

// Redis-backed recurring/seen checker so repeated polls don't republish the same story.
// Returns { seen: boolean, reason: string, key: string }
async function checkIfSeen(article) {
  const key = getSeenKey(article);
  if (!CONFIG.dedupeEnabled) {
    return { seen: false, reason: 'dedupe disabled', key };
  }

  const cached = await redis.get(key);
  if (cached) {
    return { seen: true, reason: 'already seen in Redis cache', key };
  }

  return { seen: false, reason: 'new article', key };
}

async function markAsSeen(article, keyFromCheck) {
  if (!CONFIG.dedupeEnabled) return;
  const key = keyFromCheck || getSeenKey(article);
  await redis.setex(key, CONFIG.seenTtlSeconds, '1');
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
// Returns { relevant: boolean, reason: string }
async function isMarketRelevant(article) {
  const text = `${article.title || ''} ${article.description || ''} ${article.source || ''}`.toLowerCase();

  // Reject keywords (local/sports/entertainment/weather/crime/human interest)
  const rejectKeywords = [
    'local', 'community', 'high school', 'county', 'town', 'municipal',
    'sports', 'match', 'score', 'game', 'season', 'player', 'coach',
    'entertainment', 'movie', 'film', 'celebrity', 'music', 'concert',
    'weather', 'storm', 'flooding', 'hurricane', 'tornado',
    'crime', 'arrest', 'murder', 'shooting', 'robbery',
    'human interest', 'profile', 'lifestyle', 'opinion', 'column',
  ];

  for (const k of rejectKeywords) {
    if (text.includes(k)) return { relevant: false, reason: `matched reject keyword '${k}'` };
  }

  // Approve keywords (macro, policy, regulatory, supply chain, commodity, earnings, central bank, trade)
  const acceptKeywords = [
    'regulation', 'regulatory', 'policy', 'sanction', 'tariff', 'trade policy',
    'budget', 'fiscal', 'central bank', 'fed', 'reserve', 'interest rate', 'rate decision',
    'gross domestic product', 'gdp', 'unemployment', 'inflation', 'cpi',
    'supply chain', 'shipment', 'port', 'logistic', 'shortage', 'disruption',
    'commodity', 'oil', 'gas', 'mining', 'separation', 'metals', 'copper', 'lithium', 'rare earth',
    'earnings', 'quarter', 'q1', 'q2', 'q3', 'q4', 'revenue', 'profit', 'guidance', 'beat', 'miss',
    'contract', 'procurement', 'award', 'signed', 'order', 'procure',
    'defense', 'military', 'nato', 'intelligence', 'surveillance',
    'merger', 'acquisition', 'ipo', 'bankruptcy', 'restructuring',
  ];

  for (const k of acceptKeywords) {
    if (text.includes(k)) return { relevant: true, reason: `matched accept keyword '${k}'` };
  }

  // If none matched, do a heuristic: look for corporate tickers or company names (uppercase 2-5 letter tokens)
  const tickerLike = (article.title || '').match(/\b[A-Z]{2,5}\b/g) || [];
  if (tickerLike.length > 0) return { relevant: true, reason: 'found ticker-like tokens in title' };

  // Default: not relevant to public markets
  return { relevant: false, reason: 'no market-related keywords or ticker tokens found' };
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

    // Relevance pre-filter
    try {
      const { relevant, reason } = await isMarketRelevant(article);
      if (!relevant) {
        console.log(`Skipping not market-relevant (${reason}): ${article.title}`);
        continue;
      }
    } catch (err) {
      console.warn('Relevance filter failed, allowing article through:', err && err.message);
    }
    try {
      // Check recurring/seen articles across poll runs (Redis cache)
      const seenCheck = await checkIfSeen(article);
      if (seenCheck.seen) {
        console.log(`Skipping duplicate (${seenCheck.reason}): ${article.title}`);
        continue;
      }

      // Check semantic deduplication (same story, different reporter) within this poll
      const isDuplicate = seenTitles.some((seenTitle) => isSimilarTitle(article.title, seenTitle));
      if (isDuplicate) {
        console.log(`Skipping duplicate (same story, different reporter): ${article.title}`);
        continue;
      }

      seenTitles.push(article.title);
      await redis.xadd('news:raw', '*', 'article', JSON.stringify(article));
      await markAsSeen(article, seenCheck.key);
      console.log(`Published: ${article.title}`);
      published++;
    } catch (error) {
      console.error(`Failed to publish article "${article.title}": ${error.message}`);
    }
  }

  return published;
}

async function poll() {
  console.log('Starting news poller...');

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

  // Run immediately on startup
  await pollOnce();

  // Then schedule recurring polls
  setInterval(pollOnce, POLL_INTERVAL_MS);
}

module.exports = { poll };
