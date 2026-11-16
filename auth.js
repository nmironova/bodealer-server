'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');
const bearerToken = /^[A-Za-z0-9._~+/-]+=*$/;
const digest = (value) => createHash('sha256').update(value, 'utf8').digest();

function createTokenAuth(env = process.env) {
  const token = env.BACKEND_API_TOKEN || '';
  if (!token.trim()) {
    if (env.NODE_ENV === 'production') {
      throw new Error('BACKEND_API_TOKEN is required in production');
    }
    return (_req, _res, next) => next();
  }
  if (!bearerToken.test(token)) {
    throw new Error('BACKEND_API_TOKEN must be a Bearer token without whitespace');
  }
  const expected = digest(token);
  return (req, res, next) => {
    if (req.method === 'GET' && req.path === '/health') return next();
    const authorization = req.headers.authorization;
    const match = typeof authorization === 'string'
      ? /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization) : null;
    // Equal-sized digests avoid leaking the configured token's length.
    if (!match || !timingSafeEqual(digest(match[1]), expected)) {
      res.set('WWW-Authenticate', 'Bearer');
      res.set('Cache-Control', 'no-store');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

module.exports = { createTokenAuth };
