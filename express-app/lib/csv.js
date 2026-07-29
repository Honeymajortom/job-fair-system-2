// Dependency-free CSV serializer for the Reports tab's download buttons
// (new_architecture_uiux_spec.html §06). Handles the two non-flat value
// shapes the six report queries return: TIMESTAMPTZ columns (pg gives back
// Date objects — ISO string, not Date.toString()'s verbose form) and
// master-report's ratings JSONB column (stringified inline).
//
// headers is optional but every call site in routes/reports.js passes it
// explicitly: deriving columns from rows[0] meant a 0-row result (a
// legitimate "no data for this filter" case, not an error) produced a
// literal zero-byte file — no header row, nothing — which read as a broken
// download rather than "nothing matched." Passing the column list up front
// keeps the header row (and therefore a recognizable, non-empty CSV) even
// when there are no data rows to go with it.
function toCsv(rows, headers) {
  const cols = headers || (rows.length ? Object.keys(rows[0]) : []);
  if (!cols.length) return '';
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((h) => cell(r[h])).join(','))].join('\r\n');
}

module.exports = { toCsv };
