const Redis = require('ioredis');

function createRedisClient(redisUrl) {
  if (!redisUrl) {
    throw new Error('REDIS_URL is required');
  }

  const isCloudRedis = /^rediss:\/\//i.test(redisUrl) || /upstash/i.test(redisUrl);

  return new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
    connectTimeout: 10000,
    tls: isCloudRedis ? {} : undefined,
  });
}

module.exports = { createRedisClient };