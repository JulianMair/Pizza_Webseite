'use strict';

const { HttpError } = require('./errors');

// Einfacher Fixed Window Limiter im Speicher, ausreichend für eine einzelne Instanz.
function createLimiter({ windowMs, max, message }) {
  const hits = new Map();

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, Math.min(windowMs, 60000));
  timer.unref();

  function check(key) {
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const err = new HttpError(429, message);
      err.retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      throw err;
    }
  }

  function reset(key) {
    hits.delete(key);
  }

  function middleware(req, res, next) {
    try {
      check(req.ip);
      next();
    } catch (err) {
      res.set('Retry-After', String(err.retryAfter));
      next(err);
    }
  }

  return { check, reset, middleware };
}

module.exports = { createLimiter };
