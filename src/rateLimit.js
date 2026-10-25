/** 极简内存限流器：用于登录失败、注册等敏感接口 */
const buckets = new Map();

function keyFor(req, suffix = '') {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  return `${ip}:${suffix}`;
}

/**
 * @returns {{ok: boolean, retryAfter: number, remaining: number}}
 */
export function hit(req, { suffix = '', limit = 10, windowMs = 5 * 60 * 1000 } = {}) {
  const key = keyFor(req, suffix);
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  const remaining = Math.max(0, limit - bucket.count);
  return {
    ok: bucket.count <= limit,
    remaining,
    retryAfter: Math.ceil((bucket.resetAt - now) / 1000),
  };
}

export function reset(req, { suffix = '' } = {}) {
  buckets.delete(keyFor(req, suffix));
}

/** 定期清理过期桶，避免内存膨胀 */
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) buckets.delete(key);
  }
}, 60 * 1000).unref?.();
