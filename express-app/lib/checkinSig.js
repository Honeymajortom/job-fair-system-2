require('dotenv').config();
const crypto = require('crypto');

if (!process.env.SERVER_SECRET) {
  throw new Error('SERVER_SECRET is not set — copy .env.example to .env and fill it in');
}

// v3.0 §6: the schedule card QR encodes "{token_no}.{checkin_sig}".
// The gate recomputes the HMAC — a hand-drawn or guessed QR fails instantly.
function signToken(tokenNo) {
  return crypto.createHmac('sha256', process.env.SERVER_SECRET).update(tokenNo).digest('hex');
}

// Parses "A-42.f3ab91…" and verifies the signature. Returns the token_no on
// success, null on any malformation or mismatch (timing-safe compare).
function verifyQr(qr) {
  if (typeof qr !== 'string') return null;
  const dot = qr.indexOf('.');
  if (dot <= 0) return null;
  const tokenNo = qr.slice(0, dot);
  const sig = qr.slice(dot + 1);
  const expected = signToken(tokenNo);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return tokenNo;
}

module.exports = { signToken, verifyQr };
