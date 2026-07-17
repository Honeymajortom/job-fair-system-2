// Canonical mobile form — digits only, +91/leading country code stripped to
// the 10-digit national number. Used for BOTH storage/dedup and the L1 rate
// limit key: "+91 99999 04001" and "9999904001" must be the same person.
// Deliberately permissive about length here — isValidMobile below is the
// actual gate; this just normalizes whatever shape came in.
function normalizeMobile(mobile) {
  if (typeof mobile !== 'string') return null;
  const digits = mobile.replace(/\D/g, '');
  if (!digits) return null;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

// Red-team finding (2026-07-17): normalizeMobile() alone accepts ANY
// non-empty digit string ("1", "2", "3"...) as a "mobile number" — since the
// re-registration guard (idx_candidates_mobile / registerCandidate.js's dup
// check) is keyed entirely on mobile, that made it trivial to defeat by
// incrementing a fake digit each time. Indian mobile numbers are exactly 10
// digits starting 6-9 (TRAI numbering plan) — this is the actual dedup gate;
// normalizeMobile() just shapes the input first.
const MOBILE_RE = /^[6-9]\d{9}$/;
function isValidMobile(mobile) {
  const norm = normalizeMobile(mobile);
  return !!norm && MOBILE_RE.test(norm);
}

module.exports = { normalizeMobile, isValidMobile };
