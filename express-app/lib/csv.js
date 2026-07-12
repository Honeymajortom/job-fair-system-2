// Dependency-free CSV serializer for the Reports tab's download buttons
// (new_architecture_uiux_spec.html §06). Handles the two non-flat value
// shapes the six report queries return: TIMESTAMPTZ columns (pg gives back
// Date objects — ISO string, not Date.toString()'s verbose form) and
// master-report's ratings JSONB column (stringified inline).
function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\r\n');
}

module.exports = { toCsv };
