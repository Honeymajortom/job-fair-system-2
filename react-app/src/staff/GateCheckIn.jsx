import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { api } from '../api';
import { useAuth } from './AuthContext';
import { useCenter } from './CenterContext';
import CandidateLookup from './CandidateLookup';
import './Gate.css';

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

function fmtDate(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function GateCheckIn() {
  const { user } = useAuth();
  const { centers, selectedCenterId, effectiveCenterId } = useCenter();
  const [mode, setMode] = useState('entrance'); // 'entrance' | 'exit' — same scanner, opposite direction
  const [batches, setBatches] = useState(null);
  const [manualToken, setManualToken] = useState('');
  const [log, setLog] = useState([]);
  const [toast, setToast] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [entranceQr, setEntranceQr] = useState(null); // { dataUrl, fairName, expiresAt }
  const [generatingQr, setGeneratingQr] = useState(false);
  // Only shown/required when the Nav switcher is on "All centers" and 2+
  // Centers exist — fair_cycle_isolation_plan.md Phase 5 follow-up: which
  // Center this QR registers into is decided once, at mint time, not
  // re-derived ambiguously per registration.
  const [qrCenterId, setQrCenterId] = useState('');
  const [waitingRooms, setWaitingRoomsState] = useState([]);
  const [roomEdits, setRoomEdits] = useState({}); // floor_number -> location being edited
  const [savingRoomFloor, setSavingRoomFloor] = useState(null);
  const [newRoomFloor, setNewRoomFloor] = useState('');
  const [newRoomLocation, setNewRoomLocation] = useState('');
  const [addingRoom, setAddingRoom] = useState(false);
  const [fairSettings, setFairSettings] = useState(null);

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const detectorRef = useRef(null);
  const intervalRef = useRef(null);
  const pausedRef = useRef(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  function showToast(text, isErr) {
    setToast({ text, isErr });
    setTimeout(() => setToast(null), 2500);
  }

  function loadBatches() {
    api.getBatches(effectiveCenterId).then(setBatches).catch((err) => showToast(err.message, true));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadBatches(); }, [effectiveCenterId]);

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

  // Admin only — read-only here (matches Gate.html: just a status pill).
  // Starting/ending the fair itself now lives on the Floor tab instead,
  // next to its Day picker, since that's the screen an admin actually needs
  // it from before any dates exist for that dropdown to offer.
  function loadFairSettings() {
    api.getFairSettings(effectiveCenterId).then(setFairSettings).catch(() => {});
  }

  useEffect(() => {
    if (user.role !== 'admin') return;
    loadFairSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveCenterId]);

  useEffect(() => stopCamera, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function submitCheckIn(payload) {
    const exitMode = modeRef.current === 'exit';
    setSubmitting(true);
    try {
      const res = exitMode ? await api.exitCandidate(payload) : await api.checkIn(payload);
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

  // Batches are created automatically now (lib/batchAssignment.js) — the one
  // manual action left is closing a wave once it's done, so new arrivals stop
  // being assigned to it and roll onto the next one.
  // Optimistic: the row flips to "Closed" immediately (new arrivals stop
  // landing in it from that instant in the staff's mental model) instead of
  // waiting on the round trip + a full loadBatches() refetch; a failure
  // reverts just this row's status and surfaces an error toast.
  async function closeBatch(id) {
    setBatches((rows) => rows.map((b) => (b.id === id ? { ...b, status: 'closed' } : b)));
    try {
      await api.setBatchStatus(id, 'closed');
      showToast('Batch closed');
    } catch (err) {
      setBatches((rows) => rows.map((b) => (b.id === id ? { ...b, status: 'upcoming' } : b)));
      showToast(err.message, true);
    }
  }

  // Admin / Registration Staff: mint the fair-wide registration QR
  // (routes/public.js GET /api/qr/token) and render it as an actual
  // scannable image for the entrance poster — one shared code every
  // candidate scans to reach /register, distinct from each candidate's own
  // personal check-in QR.
  async function generateEntranceQr() {
    const targetCenterId = selectedCenterId || qrCenterId;
    if (user.role === 'admin' && !targetCenterId && centers.length > 1) {
      showToast('Pick a center', true);
      return;
    }
    setGeneratingQr(true);
    try {
      const res = await api.qrToken(targetCenterId || undefined);
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

  // Read-only status pill only (Start/End now lives on Floor, see above) — on
  // admin's "All centers" switcher view with 2+ Centers, this just shows
  // whichever active fair sorts first, since there's no single right answer
  // once concurrent centers can each have their own. registration_staff never
  // hits this ambiguity: resolveCenterFilter always pins their fetch to their
  // own center server-side regardless of the switcher.
  const activeFair = fairSettings && fairSettings.find((f) => f.is_active);
  const exitMode = mode === 'exit';
  // Gate operations (batch close, entrance QR mint) are Admin + Registration
  // Staff — both roles actually staff the entrance.
  const canManageGate = user.role === 'admin' || user.role === 'registration_staff';

  return (
    <div className="s-body industry-v2 gate-v2">
      <div>
        <h2 className="screen-title">Gate {exitMode ? 'exit-scan' : 'check-in'}</h2>
        <p className="gv-subtitle">{exitMode ? 'Exit' : 'Entrance'} gate</p>
      </div>

      {/* Job fair + Direction, one card — matches Gate.html's grouping: a
          header row (kicker+title on the left, status pill on the right),
          then Direction as its own field below it. The mockup's pill is
          read-only (no start/end control exists there); the Start/End
          button is real functionality the toy mockup didn't need, so it
          gets its own row under the header rather than crowding into it. */}
      <div className="gv-card">
        {user.role === 'admin' && (
          <>
            <div className="gv-card-head">
              <div>
                <div className="gv-kicker">Job fair</div>
                <div className="gv-title">SDC Job Fair</div>
              </div>
              <span className={`checkin-status ${activeFair ? 'in' : 'out'}`} style={{ marginTop: 0 }}>
                {activeFair ? `Active · ${fmtDate(activeFair.fair_date)}` : 'Not started'}
              </span>
            </div>
            {!fairSettings && <p className="save-note" style={{ textAlign: 'left' }}>Loading…</p>}
          </>
        )}
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Direction</label>
          <div className="seg">
            <button type="button" className={mode === 'entrance' ? 'on' : ''} onClick={() => setMode('entrance')}>Entrance</button>
            <button type="button" className={mode === 'exit' ? 'on' : ''} onClick={() => setMode('exit')}>Exit</button>
          </div>
        </div>
      </div>

      {/* Check-in card: camera, token/button, then Recent inline at the
          bottom — same card the mockup keeps them all in, rather than a
          separate trailing "Recent" card. */}
      <div className="gv-card">
        <div className="gv-kicker">{exitMode ? 'Check out' : 'Check in'}</div>

        {CAMERA_SUPPORTED && (
          <div className="gv-cam-frame">
            <video ref={videoRef} muted playsInline style={{ width: '100%', borderRadius: 8, border: '1px solid var(--line)', display: scanning ? 'block' : 'none', background: '#000' }} />
            <canvas ref={canvasRef} style={{ display: 'none' }} />
            {/* Filled/primary while active, matching the mockup's
                cameraBtnClass toggle (btn-secondary -> btn-primary) — a real
                visual state change, not just a text swap. */}
            {!scanning ? (
              <button className="btn ghost" style={{ minHeight: 48 }} type="button" onClick={startCamera}>
                📷 Start camera
              </button>
            ) : (
              <button className="btn" style={{ minHeight: 48 }} type="button" onClick={stopCamera}>
                📷 Stop camera
              </button>
            )}
          </div>
        )}

        <form onSubmit={submitManual} style={{ display: 'contents' }}>
          <div className="search-bar">
            <div className="field">
              <label>{exitMode ? 'Token exit' : 'Candidate token'}</label>
              <input value={manualToken} onChange={(e) => setManualToken(e.target.value)} placeholder="A-42" />
            </div>
            <button className="btn" style={{ width: 'auto', padding: '0 22px', minHeight: 48 }} type="submit" disabled={submitting || !manualToken.trim()}>{exitMode ? 'Check out' : 'Check in'}</button>
          </div>
        </form>

        <div className="gv-recent">
          {log.map((row) => (
            <div key={row.ts} className={`ci-row${row.ok ? ' done' : ''}`}>
              <span className="tk">{row.token}</span>
              {row.ok ? <span>{row.name}</span> : <span className="error-note" style={{ marginTop: 0 }}>{row.message}</span>}
              {row.ok && (row.exited ? <span className="ci-state">Exited</span> : <span className="ci-state">{row.checked_in}/{row.capacity}</span>)}
            </div>
          ))}
          {!log.length && <p className="save-note" style={{ marginTop: 0 }}>No check-ins yet this session.</p>}
        </div>
      </div>

      {/* Entrance-only order matches Gate.html exactly: Entrance QR, then
          Waiting rooms per floor, then Arrival batches — previously had
          batches first, which was the wrong sequence. */}
      {!exitMode && (
        <>
          {canManageGate && (
            <div className="gv-card">
              <div className="gv-kicker">Entrance QR</div>
              <p className="gv-body">Candidates scan this at the gate to register their arrival.</p>
              {!entranceQr && user.role === 'admin' && !selectedCenterId && centers.length > 1 && (
                <div className="field" style={{ maxWidth: 200, marginBottom: 8 }}>
                  <label>Center</label>
                  <select value={qrCenterId} onChange={(e) => setQrCenterId(e.target.value)} required>
                    <option value="" disabled>Select…</option>
                    {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              )}
              {entranceQr ? (
                <div className="gv-qr-row">
                  <img src={entranceQr.dataUrl} alt="Entrance registration QR" width={58} height={58} style={{ borderRadius: 6, border: '1px solid var(--line)' }} />
                  <button className="btn ghost" style={{ width: 'auto', padding: '8px 14px' }} onClick={generateEntranceQr} disabled={generatingQr}>
                    {generatingQr ? 'Generating…' : 'Regenerate'}
                  </button>
                </div>
              ) : (
                <button className="btn" style={{ width: 'auto', padding: '8px 14px', alignSelf: 'flex-start' }} onClick={generateEntranceQr} disabled={generatingQr}>
                  {generatingQr ? 'Generating…' : 'Generate entrance QR'}
                </button>
              )}
              {entranceQr && (
                <p className="save-note" style={{ textAlign: 'left' }}>
                  {entranceQr.fairName} — print for the entrance.
                  {entranceQr.expiresAt && ` Valid until ${entranceQr.expiresAt.toLocaleString()}.`}
                </p>
              )}
            </div>
          )}

          {user.role === 'admin' && (
            <div className="gv-card">
              <div className="gv-kicker">Waiting rooms, per floor</div>
              <p className="gv-body">
                Matched against each company's floor — a candidate waiting for a Floor 2 company is told to sit in the Floor 2 room, not a fair-wide generic one.
              </p>
              <div>
                {waitingRooms.map((r) => (
                  <div key={r.floor_number} className="gv-room-row" style={{ alignItems: 'end', gap: 8 }}>
                    <div className="field" style={{ maxWidth: 70, marginBottom: 0 }}>
                      <label>Floor</label>
                      <input value={r.floor_number} disabled className="mono" />
                    </div>
                    <div className="field" style={{ flex: 1, marginBottom: 0 }}>
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
              </div>
              {!waitingRooms.length && <p className="save-note">No waiting rooms configured yet.</p>}
              <form onSubmit={addWaitingRoom} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
                <div className="field" style={{ maxWidth: 70, marginBottom: 0 }}>
                  <label>Floor</label>
                  <input type="number" min="0" value={newRoomFloor} onChange={(e) => setNewRoomFloor(e.target.value)} placeholder="0" />
                </div>
                <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                  <label>Location</label>
                  <input value={newRoomLocation} onChange={(e) => setNewRoomLocation(e.target.value)} placeholder="Main Hall" />
                </div>
                <button className="btn ghost" style={{ width: 'auto', padding: '8px 14px' }} type="submit" disabled={addingRoom}>
                  {addingRoom ? 'Adding…' : '+ Add floor'}
                </button>
              </form>
            </div>
          )}

          {/* Real feature the mockup never had — placed right before Arrival
              batches, entrance-only (staff manage candidates on the way in,
              not on the way out). */}
          {canManageGate && (
            <div className="gv-card">
              <CandidateLookup />
            </div>
          )}

          {canManageGate && (
            <div className="gv-card">
              <div className="gv-card-head">
                <div className="gv-kicker">Arrival batches</div>
              </div>
              <p className="gv-body" style={{ margin: 0 }}>
                Created automatically as candidates register or check in — nothing to generate or pick by hand.
              </p>
              {/* Open batches nearest capacity float to the top (same principle
                  as Floor's "people on hand" sort) so the wave that needs a
                  Close tap next is visible without scrolling past closed ones. */}
              {batches && batches.length ? (
                <div className="gv-batches">
                  {[...batches].sort((a, b) => {
                    const aClosed = a.status === 'closed';
                    const bClosed = b.status === 'closed';
                    if (aClosed !== bClosed) return aClosed ? 1 : -1;
                    return (b.checked_in / b.capacity) - (a.checked_in / a.capacity);
                  }).map((b) => {
                    const full = b.checked_in >= b.capacity;
                    return (
                      <div key={b.id} className="gv-batch-row">
                        <div>
                          <div className="gv-batch-title">Batch {b.batch_number} <span className="gv-batch-time">· {fmtTime(b.arrival_time)}</span></div>
                          <div className="gv-batch-tags">
                            <span className={`checkin-status ${full ? 'out' : 'in'}`} style={{ marginTop: 0 }}>{b.checked_in}/{b.capacity}</span>
                            {b.status === 'closed' && <span className="checkin-status" style={{ marginTop: 0, background: 'var(--line)', color: 'var(--ink-60)' }}>Closed</span>}
                          </div>
                        </div>
                        {b.status !== 'closed' && (
                          <button className="btn ghost" style={{ width: 'auto', padding: '6px 10px' }} onClick={() => closeBatch(b.id)}>
                            Close
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="save-note">No batches yet — the first registration will create one.</p>
              )}
            </div>
          )}
        </>
      )}

      {toast && <div className={`toast${toast.isErr ? ' err' : ''}`}>{toast.text}</div>}
    </div>
  );
}
