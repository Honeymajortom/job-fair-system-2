// Canonical mobile form — digits only, +91/leading country code stripped to
// the 10-digit national number. Used for BOTH storage/dedup and the L1 rate
// limit key: "+91 99999 04001" and "9999904001" must be the same person.
function normalizeMobile(mobile) {
  if (typeof mobile !== 'string') return null;
  const digits = mobile.replace(/\D/g, '');
  if (!digits) return null;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

module.exports = { normalizeMobile };
