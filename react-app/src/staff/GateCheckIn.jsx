import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { api } from '../api';
import { useAuth } from './AuthContext';

// Camera itself just needs getUserMedia — decoding falls back to jsQR
// (pure JS, works everywhere) when the native BarcodeDetector API isn't
// there, which is most non-Chromium browsers (Safari, Firefox).
const CAMERA_SUPPORTED = typeof navigator !== 'undefined' && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
const SCAN_INTERVAL_MS = 400;
const RESUME_DELAY_MS = 1500;
const LOG_LIMIT = 10;

function decodeFrame(video, canvas, detector) {
  if (detector) return detector.detect(video).then((codes) => (codes.length ? codes[0].rawValue : null));
  if (!video.videoWidth || !video.videoHeight) return Promise.resolve(null);
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(frame.data, frame.width, frame.height);
  return Promise.resolve(code ? code.data : null);
}

// qr_token is a plain JWT (header.payload.signature) — decoding the payload
// client-side just to show staff when the poster expires needs no library,
// atob() is a standard browser global.
function decodeJwtExp(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.exp ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}

export default function GateCheckIn() {
  const { user } = useAuth();
  const [mode, setMode] = useState('entrance'); // 'entrance' | 'exit' — same scanner, opposite direction
  const [batches, setBatches] = useState(null);
  const [batchId, setBatchId] = useState('');
  const [manualToken, setManualToken] = useState('');
  const [log, setLog] = useState([]);
  const [toast, setToast] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [entranceQr, setEntranceQr] = useState(null); // { dataUrl, fairName, expiresAt }
  const [generatingQr, setGeneratingQr] = useState(false);
  const [showBatchGen, setShowBatchGen] = useState(false);
  const [batchGenCount, setBatchGenCount] = useState('');
  const [generatingBatch, setGeneratingBatch] = useState(false);
  const [waitingRooms, setWaitingRoomsState] = useState([]);
  const [roomEdits, setRoomEdits] = useState({}); // floor_number -> location being edited
  const [savingRoomFloor, setSavingRoomFloor] = useState(null);
  const [newRoomFloor, setNewRoomFloor] = useState('');
  const [newRoomLocation, setNewRoomLocation] = useState('');
  const [addingRoom, setAddingRoom] = useState(false);

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const detectorRef = useRef(null);
  const intervalRef = useRef(null);
  const pausedRef = useRef(false);
  const batchIdRef = useRef('');
  batchIdRef.current = batchId;
  const modeRef = useRef(mode);
  modeRef.current = mode;

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

  // Admin only, matching the waiting-rooms write endpoints' role — one row
  // per floor, matched against companies.floor_number so a candidate waiting
  // for a Floor 2 company gets told to sit in the Floor 2 room, not a
  // fair-wide generic one.
  function loadWaitingRooms() {
    api.getWaitingRooms().then((rows) => {
      setWaitingRoomsState(rows);
      setRoomEdits(Object.fromEntries(rows.map((r) => [r.floor_number, r.location])));
    }).catch(() => {});
  }

  useEffect(() => {
    if (user.role !== 'admin') return;
    loadWaitingRooms();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => stopCamera, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function submitCheckIn(payload) {
    const exitMode = modeRef.current === 'exit';
    if (!exitMode && !batchIdRef.current) { showToast('Pick a batch first', true); return; }
    setSubmitting(true);
    try {
      const res = exitMode ? await api.exitCandidate(payload) : await api.checkIn(batchIdRef.current, payload);
      setLog((cur) => [{
        ok: true, token: res.token, name: res.name, exited: exitMode,
        checked_in: res.checked_in, capacity: res.capacity, ts: Date.now(),
      }, ...cur].slice(0, LOG_LIMIT));
      showToast(exitMode ? `${res.token} · ${res.name} exited` : `${res.token} · ${res.name} checked in`);
      if (!exitMode) loadBatches();
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
      detectorRef.current = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
      pausedRef.current = false;
      setScanning(true);
      intervalRef.current = setInterval(async () => {
        if (pausedRef.current || !videoRef.current) return;
        try {
          const value = await decodeFrame(videoRef.current, canvasRef.current, detectorRef.current);
          if (value) {
            pausedRef.current = true;
            await submitCheckIn({ qr: value });
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

  // Admin / Registration Staff: POST /api/batches/generate needs a fair_date
  // — read it off whichever fair_settings row is active (falling back to the
  // newest one) instead of asking staff to type a date at the gate.
  async function generateBatch() {
    const count = parseInt(batchGenCount, 10);
    if (!count || count < 1 || count > 100) { showToast('Enter a batch count between 1 and 100', true); return; }
    setGeneratingBatch(true);
    try {
      const settings = await api.getFairSettings();
      const active = settings.find((s) => s.is_active) || settings[0];
      if (!active) { showToast('No fair configured yet', true); return; }
      // fair_date comes back as a full ISO timestamp (pg DATE -> JS Date ->
      // JSON) — routes/fair.js builds `${fair_date} 09:00` for the first
      // arrival, so a timestamp string here produces an invalid timestamp.
      const fairDate = active.fair_date.slice(0, 10);
      await api.generateBatches({ fair_date: fairDate, batch_count: count });
      showToast(`${count} batch${count === 1 ? '' : 'es'} generated`);
      setShowBatchGen(false);
      setBatchGenCount('');
      loadBatches();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setGeneratingBatch(false);
    }
  }

  // Admin / Registration Staff: mint the fair-wide registration QR
  // (routes/public.js GET /api/qr/token) and render it as an actual
  // scannable image for the entrance poster — one shared code every
  // candidate scans to reach /register, distinct from each candidate's own
  // personal check-in QR.
  async function generateEntranceQr() {
    setGeneratingQr(true);
    try {
      const res = await api.qrToken();
      const fullUrl = `${window.location.origin}${res.register_url}`;
      const dataUrl = await QRCode.toDataURL(fullUrl, { margin: 1, width: 240 });
      setEntranceQr({ dataUrl, fairName: res.fair_name, expiresAt: decodeJwtExp(res.qr_token) });
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setGeneratingQr(false);
    }
  }

  // floor_number is the natural key (waiting_rooms.floor_number PRIMARY KEY),
  // so saving an existing row's edited location and adding a brand-new floor
  // both just call the same upsert endpoint.
  async function saveRoomLocation(floorNumber) {
    const location = (roomEdits[floorNumber] || '').trim();
    if (!location) { showToast('Location is required', true); return; }
    setSavingRoomFloor(floorNumber);
    try {
      await api.setWaitingRoom(floorNumber, location);
      showToast(`Floor ${floorNumber} waiting room saved`);
      loadWaitingRooms();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setSavingRoomFloor(null);
    }
  }

  async function removeWaitingRoom(floorNumber) {
    if (!window.confirm(`Remove the Floor ${floorNumber} waiting room?`)) return;
    try {
      await api.deleteWaitingRoom(floorNumber);
      showToast('Waiting room removed');
      loadWaitingRooms();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function addWaitingRoom(e) {
    e.preventDefault();
    const floor = Number(newRoomFloor);
    if (newRoomFloor === '' || !Number.isInteger(floor) || floor < 0) { showToast('Floor number must be 0 or higher', true); return; }
    if (!newRoomLocation.trim()) { showToast('Location is required', true); return; }
    setAddingRoom(true);
    try {
      await api.setWaitingRoom(floor, newRoomLocation.trim());
      showToast(`Floor ${floor} waiting room added`);
      setNewRoomFloor('');
      setNewRoomLocation('');
      loadWaitingRooms();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setAddingRoom(false);
    }
  }

  const selectedBatch = batches && batches.find((b) => String(b.id) === String(batchId));
  const exitMode = mode === 'exit';
  // Gate operations (batch generation/activation, entrance QR mint) are
  // Admin + Registration Staff — both roles actually staff the entrance.
  const canManageGate = user.role === 'admin' || user.role === 'registration_staff';
  const checkInStepNum = canManageGate ? 2 : 1;

  return (
    <div className="s-body" style={{ maxWidth: 520 }}>
      <h2 className="screen-title">Gate {exitMode ? 'exit-scan' : 'check-in'}</h2>

      <div className="field" style={{ marginBottom: 16 }}>
        <label>Direction</label>
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="entrance">Entrance</option>
          <option value="exit">Exit</option>
        </select>
      </div>

      {!exitMode && (
        <>
          <div className="field" style={{ marginBottom: 12 }}>
            <label>Batch</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <select value={batchId} onChange={(e) => setBatchId(e.target.value)} style={{ flex: 1 }}>
                {(!batches || !batches.length) && <option value="">No batches yet</option>}
                {batches && batches.map((b) => (
                  <option key={b.id} value={b.id}>
                    Batch {b.batch_number} · {b.status} · {b.checked_in}/{b.capacity}
                  </option>
                ))}
              </select>
              {canManageGate && (
                <button className="btn ghost" style={{ width: 'auto', padding: '8px 14px' }} onClick={() => setShowBatchGen((v) => !v)}>
                  Generate batch
                </button>
              )}
            </div>
            {showBatchGen && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input
                  type="number"
                  min="1"
                  max="100"
                  placeholder="How many batches?"
                  value={batchGenCount}
                  onChange={(e) => setBatchGenCount(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button className="btn ghost" style={{ width: 'auto', padding: '8px 14px' }} onClick={generateBatch} disabled={generatingBatch}>
                  {generatingBatch ? 'Generating…' : 'Confirm'}
                </button>
              </div>
            )}
          </div>

          {canManageGate && selectedBatch && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <button className="btn ghost" style={{ width: 'auto', padding: '8px 14px' }} disabled={selectedBatch.status === 'active'} onClick={() => setBatchStatus('active')}>
                Activate
              </button>
              <button className="btn ghost" style={{ width: 'auto', padding: '8px 14px' }} disabled={selectedBatch.status === 'closed'} onClick={() => setBatchStatus('closed')}>
                Close
              </button>
            </div>
          )}

          {canManageGate && (
            <div className="field" style={{ marginBottom: 16 }}>
              <div className="sec-label" style={{ marginBottom: 8 }}>Step 1 · Generate entrance QR</div>
              <button className="btn ghost" style={{ width: 'auto', padding: '8px 14px' }} onClick={generateEntranceQr} disabled={generatingQr}>
                {generatingQr ? 'Generating…' : 'Generate entrance QR'}
              </button>
              {entranceQr && (
                <div style={{ marginTop: 12, textAlign: 'center' }}>
                  <img src={entranceQr.dataUrl} alt="Entrance registration QR" width={240} height={240} />
                  <p className="save-note" style={{ marginTop: 8 }}>
                    {entranceQr.fairName} — print for the entrance.
                    {entranceQr.expiresAt && ` Valid until ${entranceQr.expiresAt.toLocaleString()}.`}
                  </p>
                </div>
              )}
            </div>
          )}

          {user.role === 'admin' && (
            <div className="field" style={{ marginBottom: 16 }}>
              <div className="sec-label" style={{ marginBottom: 8 }}>Waiting rooms, per floor</div>
              <p className="save-note" style={{ marginTop: 0, marginBottom: 8 }}>
                Matched against each company's floor — a candidate waiting for a Floor 2 company is told to sit in the Floor 2 room, not a fair-wide generic one.
              </p>
              {waitingRooms.map((r) => (
                <div key={r.floor_number} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'end' }}>
                  <div className="field" style={{ maxWidth: 80 }}>
                    <label>Floor</label>
                    <input value={r.floor_number} disabled className="mono" />
                  </div>
                  <div className="field" style={{ flex: 1, maxWidth: 220 }}>
                    <label>Location</label>
                    <input
                      value={roomEdits[r.floor_number] ?? ''}
                      onChange={(e) => setRoomEdits({ ...roomEdits, [r.floor_number]: e.target.value })}
                    />
                  </div>
                  <button
                    className="btn ghost"
                    style={{ width: 'auto', padding: '8px 14px' }}
                    disabled={savingRoomFloor === r.floor_number}
                    onClick={() => saveRoomLocation(r.floor_number)}
                  >
                    {savingRoomFloor === r.floor_number ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    className="btn ghost"
                    style={{ width: 'auto', padding: '8px 14px', color: 'var(--st-rejected)' }}
                    onClick={() => removeWaitingRoom(r.floor_number)}
                  >
                    Remove
                  </button>
                </div>
              ))}
              {!waitingRooms.length && <p className="save-note" style={{ marginBottom: 8 }}>No waiting rooms configured yet.</p>}
              <form onSubmit={addWaitingRoom} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
                <div className="field" style={{ maxWidth: 80 }}>
                  <label>Floor</label>
                  <input type="number" min="0" value={newRoomFloor} onChange={(e) => setNewRoomFloor(e.target.value)} placeholder="0" />
                </div>
                <div className="field" style={{ maxWidth: 200 }}>
                  <label>Location</label>
                  <input value={newRoomLocation} onChange={(e) => setNewRoomLocation(e.target.value)} placeholder="Main Hall" />
                </div>
                <button className="btn ghost" style={{ width: 'auto', padding: '8px 14px' }} type="submit" disabled={addingRoom}>
                  {addingRoom ? 'Adding…' : '+ Add floor'}
                </button>
              </form>
            </div>
          )}
        </>
      )}

      {exitMode && (
        <p className="save-note" style={{ marginBottom: 16 }}>
          Scanning here permanently ends the candidate's session — their QR and live position link stop working right after.
        </p>
      )}

      <form onSubmit={submitManual} style={{ marginBottom: 18 }}>
        <div className="sec-label" style={{ marginBottom: 8 }}>
          {exitMode ? 'Step 1 · Scan QR or enter candidate token' : `Step ${checkInStepNum} · Check in`}
        </div>

        {CAMERA_SUPPORTED && (
          <div style={{ marginBottom: 16 }}>
            <video ref={videoRef} muted playsInline style={{ width: '100%', borderRadius: 10, border: '1px solid var(--line)', display: scanning ? 'block' : 'none', background: '#000' }} />
            <canvas ref={canvasRef} style={{ display: 'none' }} />
            {!scanning ? (
              <button className="scan-btn" style={{ width: '100%', padding: '13px' }} type="button" onClick={startCamera} disabled={!exitMode && !batchId}>
                ⌗ Start camera
              </button>
            ) : (
              <button className="scan-btn" style={{ width: '100%', padding: '13px', marginTop: 8 }} type="button" onClick={stopCamera}>
                Stop camera
              </button>
            )}
          </div>
        )}

        <div className="search-bar">
          <div className="field">
            <label>Candidate token</label>
            <input value={manualToken} onChange={(e) => setManualToken(e.target.value)} placeholder="A-42" />
          </div>
          <button className="scan-btn" type="submit" disabled={submitting || !manualToken.trim()}>{exitMode ? 'Exit candidate' : 'Check in'}</button>
        </div>

        {exitMode && (
          <div className="sec-label" style={{ marginTop: 12 }}>Step 2 · Exit candidate — scanning or submitting the token above exits them immediately</div>
        )}
      </form>

      <div className="sec-label" style={{ marginBottom: 8 }}>Recent</div>
      {log.map((row) => (
        <div key={row.ts} className={`ci-row${row.ok ? ' done' : ''}`}>
          <span className="tk">{row.token}</span>
          {row.ok ? <span>{row.name}</span> : <span className="error-note" style={{ marginTop: 0 }}>{row.message}</span>}
          {row.ok && (row.exited ? <span className="ci-state">Exited</span> : <span className="ci-state">{row.checked_in}/{row.capacity}</span>)}
        </div>
      ))}
      {!log.length && <p className="save-note">No check-ins yet this session.</p>}

      {toast && <div className={`toast${toast.isErr ? ' err' : ''}`}>{toast.text}</div>}
    </div>
  );
}
