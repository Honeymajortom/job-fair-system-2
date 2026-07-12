import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAuth } from './AuthContext';

const SCAN_SUPPORTED = typeof window !== 'undefined' && 'BarcodeDetector' in window;
const SCAN_INTERVAL_MS = 400;
const RESUME_DELAY_MS = 1500;
const LOG_LIMIT = 10;

export default function GateCheckIn() {
  const { user } = useAuth();
  const [batches, setBatches] = useState(null);
  const [batchId, setBatchId] = useState('');
  const [manualToken, setManualToken] = useState('');
  const [log, setLog] = useState([]);
  const [toast, setToast] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const detectorRef = useRef(null);
  const intervalRef = useRef(null);
  const pausedRef = useRef(false);
  const batchIdRef = useRef('');
  batchIdRef.current = batchId;

  function showToast(text, isErr) {
    setToast({ text, isErr });
    setTimeout(() => setToast(null), 2500);
  }

  function loadBatches() {
    api.getBatches().then((rows) => {
      setBatches(rows);
      setBatchId((cur) => {
        if (cur && rows.some((b) => String(b.id) === String(cur))) return cur;
        const active = rows.find((b) => b.status === 'active');
        return active ? String(active.id) : (rows[0] ? String(rows[0].id) : '');
      });
    }).catch((err) => showToast(err.message, true));
  }

  useEffect(() => { loadBatches(); }, []);

  useEffect(() => stopCamera, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function submitCheckIn(payload) {
    if (!batchIdRef.current) { showToast('Pick a batch first', true); return; }
    setSubmitting(true);
    try {
      const res = await api.checkIn(batchIdRef.current, payload);
      setLog((cur) => [{ ok: true, token: res.token, name: res.name, checked_in: res.checked_in, capacity: res.capacity, ts: Date.now() }, ...cur].slice(0, LOG_LIMIT));
      showToast(`${res.token} · ${res.name} checked in`);
      loadBatches();
    } catch (err) {
      setLog((cur) => [{ ok: false, token: payload.candidate_token || '—', message: err.message, ts: Date.now() }, ...cur].slice(0, LOG_LIMIT));
      showToast(err.message, true);
    } finally {
      setSubmitting(false);
    }
  }

  function submitManual(e) {
    e.preventDefault();
    if (!manualToken.trim()) return;
    submitCheckIn({ candidate_token: manualToken.trim() });
    setManualToken('');
  }

  function stopCamera() {
    clearInterval(intervalRef.current);
    intervalRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setScanning(false);
  }

  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      detectorRef.current = new window.BarcodeDetector({ formats: ['qr_code'] });
      pausedRef.current = false;
      setScanning(true);
      intervalRef.current = setInterval(async () => {
        if (pausedRef.current || !videoRef.current) return;
        try {
          const codes = await detectorRef.current.detect(videoRef.current);
          if (codes.length) {
            pausedRef.current = true;
            await submitCheckIn({ qr: codes[0].rawValue });
            setTimeout(() => { pausedRef.current = false; }, RESUME_DELAY_MS);
          }
        } catch { /* transient detect() failure — next tick tries again */ }
      }, SCAN_INTERVAL_MS);
    } catch (err) {
      showToast('Camera unavailable: ' + err.message, true);
    }
  }

  async function setBatchStatus(status) {
    if (!batchId) return;
    try {
      await api.setBatchStatus(batchId, status);
      showToast(`Batch ${status}`);
      loadBatches();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  const selectedBatch = batches && batches.find((b) => String(b.id) === String(batchId));

  return (
    <div className="s-body" style={{ maxWidth: 520 }}>
      <h2 className="screen-title">Gate check-in</h2>

      <div className="field" style={{ marginBottom: 12 }}>
        <label>Batch</label>
        <select value={batchId} onChange={(e) => setBatchId(e.target.value)}>
          {(!batches || !batches.length) && <option value="">No batches yet</option>}
          {batches && batches.map((b) => (
            <option key={b.id} value={b.id}>
              Batch {b.batch_number} · {b.status} · {b.checked_in}/{b.capacity}
            </option>
          ))}
        </select>
      </div>

      {user.role === 'admin' && selectedBatch && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button className="btn ghost" style={{ width: 'auto', padding: '8px 14px' }} disabled={selectedBatch.status === 'active'} onClick={() => setBatchStatus('active')}>
            Activate
          </button>
          <button className="btn ghost" style={{ width: 'auto', padding: '8px 14px' }} disabled={selectedBatch.status === 'closed'} onClick={() => setBatchStatus('closed')}>
            Close
          </button>
        </div>
      )}

      {SCAN_SUPPORTED && (
        <div style={{ marginBottom: 16 }}>
          <video ref={videoRef} muted playsInline style={{ width: '100%', borderRadius: 10, border: '1px solid var(--line)', display: scanning ? 'block' : 'none', background: '#000' }} />
          {!scanning ? (
            <button className="scan-btn" style={{ width: '100%', padding: '13px' }} onClick={startCamera} disabled={!batchId}>
              ⌗ Start camera
            </button>
          ) : (
            <button className="scan-btn" style={{ width: '100%', padding: '13px', marginTop: 8 }} onClick={stopCamera}>
              Stop camera
            </button>
          )}
        </div>
      )}

      <form onSubmit={submitManual} className="search-bar" style={{ marginBottom: 18 }}>
        <div className="field">
          <label>Candidate token</label>
          <input value={manualToken} onChange={(e) => setManualToken(e.target.value)} placeholder="A-42" />
        </div>
        <button className="scan-btn" type="submit" disabled={submitting || !manualToken.trim()}>Check in</button>
      </form>

      <div className="sec-label" style={{ marginBottom: 8 }}>Recent</div>
      {log.map((row) => (
        <div key={row.ts} className={`ci-row${row.ok ? ' done' : ''}`}>
          <span className="tk">{row.token}</span>
          {row.ok ? <span>{row.name}</span> : <span className="error-note" style={{ marginTop: 0 }}>{row.message}</span>}
          {row.ok && <span className="ci-state">{row.checked_in}/{row.capacity}</span>}
        </div>
      ))}
      {!log.length && <p className="save-note">No check-ins yet this session.</p>}

      {toast && <div className={`toast${toast.isErr ? ' err' : ''}`}>{toast.text}</div>}
    </div>
  );
}
