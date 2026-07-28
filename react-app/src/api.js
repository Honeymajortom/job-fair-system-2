import { io } from 'socket.io-client';

// Session-expired (mid-use 401, not the initial /me check AuthContext.jsx
// already handles, and not the public candidate paths below which have no
// session to expire) — AuthContext.jsx registers a callback here so a 401
// anywhere in the staff app can drop `user` back to null and let StaffApp's
// existing Gate redirect to /staff/login do the rest, instead of every
// staff screen needing its own 401-handling logic.
let onUnauthorized = null;
export function setOnUnauthorized(fn) { onUnauthorized = fn; }

// /login's own 401 is a wrong-password result, not a session expiring —
// redirecting from the login screen back to itself would be silly. /me's
// 401 on cold load is the normal "not logged in yet" case, already handled
// by AuthContext's checkSession. /qr/* and /gate-status are the public
// candidate/kiosk paths, which never carry a staff session to expire.
function isAuthExempt(path) {
  return path === '/login' || path === '/me' || path === '/gate-status' || path.startsWith('/qr/');
}

function handleUnauthorized(path, status) {
  if (status === 401 && onUnauthorized && !isAuthExempt(path)) onUnauthorized();
}

// All calls go through the Vite dev proxy (or Nginx in prod), so paths are
// relative and the HttpOnly session cookie rides along automatically.
async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    handleUnauthorized(path, res.status);
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// FormData needs the browser to set its own boundary-bearing Content-Type —
// request()'s hardcoded 'application/json' header would break the multipart
// body, so this is a standalone fetch matching request()'s credentials +
// error shape rather than a request() variant.
async function uploadFile(path, formData) {
  const res = await fetch(`/api${path}`, { method: 'POST', credentials: 'include', body: formData });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    handleUnauthorized(path, res.status);
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Builds "?a=1&b=2" from an object, skipping undefined/null/'' values — used
// wherever an endpoint takes more than one optional filter (date, center_id)
// so callers can pass whichever ones they have without hand-building strings.
function qs(params) {
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!pairs.length) return '';
  return `?${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
}

export const api = {
  // public candidate path
  // qr (optional): the candidate's own signed check-in QR, scopes the list to
  // their Center server-side (routes/public.js) instead of showing every
  // is_open company system-wide.
  qrCompanies: (qr) => request(`/qr/companies${qs({ qr })}`),
  qrRegister: (payload) => request('/qr/register', { method: 'POST', body: JSON.stringify(payload) }),
  // qr here is the signed "{token_no}.{HMAC}" string (registerCandidate's
  // `result.qr`), not the bare token — the server verifies the signature
  // before accepting the upload, since bare token_no is guessable.
  uploadResume: (qr, file) => {
    const formData = new FormData();
    formData.append('resume', file);
    return uploadFile(`/qr/resume/${encodeURIComponent(qr)}`, formData);
  },
  qrSchedule: (token) => request(`/qr/schedule/${token}`),
  // qr here is the signed "{token_no}.{HMAC}" string, same as uploadResume/
  // submitFeedback — not the bare token, since this is a write endpoint.
  selectCompanies: (qr, company_ids) => request(`/qr/select-companies/${encodeURIComponent(qr)}`, { method: 'POST', body: JSON.stringify({ company_ids }) }),
  // qr here is the same signed "{token_no}.{HMAC}" string as the writes
  // above — see routes/public.js POST /qr/acknowledge/:qr. Notifies Company
  // HR's desk tablet that the candidate is on their way, purely informational.
  acknowledgeArrival: (qr) => request(`/qr/acknowledge/${encodeURIComponent(qr)}`, { method: 'POST' }),
  recoverToken: (payload) => request('/qr/recover', { method: 'POST', body: JSON.stringify(payload) }),
  // qr here is the same signed "{token_no}.{HMAC}" string uploadResume uses,
  // not the bare token — see routes/public.js POST /qr/feedback/:qr.
  submitFeedback: (qr, payload) => request(`/qr/feedback/${encodeURIComponent(qr)}`, { method: 'POST', body: JSON.stringify(payload) }),
  // qr here is the same signed string too — see routes/public.js POST
  // /qr/company-interest/:qr. Shown before submitFeedback above.
  submitCompanyInterest: (qr, interests) => request(`/qr/company-interest/${encodeURIComponent(qr)}`, { method: 'POST', body: JSON.stringify({ interests }) }),
  getGateStatus: () => request('/gate-status'),

  // auth
  login: (username, password) => request('/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  me: () => request('/me'),
  logout: () => request('/logout', { method: 'POST' }),

  // staff
  getCompanies: (centerId) => request(`/companies${qs({ center_id: centerId })}`),
  getCompany: (id) => request(`/companies/${id}`),
  createCompany: (payload) => request('/companies', { method: 'POST', body: JSON.stringify(payload) }),
  updateCompany: (id, payload) => request(`/companies/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  setCompanyOpenStatus: (id, is_open) => request(`/companies/${id}/open-status`, { method: 'PUT', body: JSON.stringify({ is_open }) }),
  deleteCompany: (id) => request(`/companies/${id}`, { method: 'DELETE' }),
  addRatingParameter: (id, payload) => request(`/companies/${id}/rating-parameters`, { method: 'POST', body: JSON.stringify(payload) }),
  deleteRatingParameter: (id, paramId) => request(`/companies/${id}/rating-parameters/${paramId}`, { method: 'DELETE' }),
  addCompanyPost: (id, payload) => request(`/companies/${id}/posts`, { method: 'POST', body: JSON.stringify(payload) }),
  updateCompanyPost: (id, postId, payload) => request(`/companies/${id}/posts/${postId}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteCompanyPost: (id, postId) => request(`/companies/${id}/posts/${postId}`, { method: 'DELETE' }),
  register: (payload) => request('/register', { method: 'POST', body: JSON.stringify(payload) }),
  listCandidates: (date, centerId, mobile) => request(`/candidates${qs({ date, center_id: centerId, mobile })}`),
  getCandidate: (token) => request(`/candidates/${token}`),
  addCandidateCompanies: (id, company_ids) => request(`/candidates/${id}/companies`, { method: 'POST', body: JSON.stringify({ company_ids }) }),
  removeCandidateCompany: (id, companyId) => request(`/candidates/${id}/companies/${companyId}`, { method: 'DELETE' }),
  reactivateCandidateCompany: (id, companyId) => request(`/candidates/${id}/companies/${companyId}/reactivate`, { method: 'POST' }),
  rescheduleBatch: (id, batch_id) => request(`/candidates/${id}/batch`, { method: 'PUT', body: JSON.stringify({ batch_id }) }),
  getQueue: (companyId) => request(`/queue/${companyId}`),
  getCompletedToday: (companyId) => request(`/queue/${companyId}/completed`),
  submitResult: (payload) => request('/interview-result', { method: 'PUT', body: JSON.stringify(payload) }),
  markNoShow: (payload) => request('/no-show', { method: 'POST', body: JSON.stringify(payload) }),
  // queue-system Phase 3/4 — desk tablet
  getDeskOccupant: (companyId, deskId) => request(`/queue/desk/${companyId}/${deskId}`),
  deskNext: (payload) => request('/queue/desk/next', { method: 'POST', body: JSON.stringify(payload) }),
  confirmArrival: (payload) => request('/queue/confirm-arrival', { method: 'POST', body: JSON.stringify(payload) }),
  pauseArrival: (payload) => request('/queue/pause-arrival', { method: 'POST', body: JSON.stringify(payload) }),
  resumeArrival: (payload) => request('/queue/resume-arrival', { method: 'POST', body: JSON.stringify(payload) }),
  getStats: () => request('/stats'),
  getFloorStats: (date, centerId) => request(`/floor-stats${qs({ date, center_id: centerId })}`),
  getBatches: (centerId) => request(`/batches${qs({ center_id: centerId })}`),
  setBatchStatus: (id, status) => request(`/batch/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
  checkIn: (payload) => request('/batch/check-in', { method: 'POST', body: JSON.stringify(payload) }),
  exitCandidate: (payload) => request('/candidates/exit', { method: 'POST', body: JSON.stringify(payload) }),
  qrToken: (centerId) => request(`/qr/token${qs({ center_id: centerId })}`),

  // fair config (admin)
  getFairSettings: (centerId) => request(`/fair-settings${qs({ center_id: centerId })}`),
  createFairSettings: (payload) => request('/fair-settings', { method: 'POST', body: JSON.stringify(payload) }),
  updateFairSettings: (id, payload) => request(`/fair-settings/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  activateFair: (payload) => request('/fair-settings/activate', { method: 'POST', body: JSON.stringify(payload) }),
  archiveFair: (id) => request(`/fair-settings/${id}/archive`, { method: 'POST' }),
  deleteFairSettings: (id) => request(`/fair-settings/${id}`, { method: 'DELETE' }),
  generateBatches: (payload) => request('/batches/generate', { method: 'POST', body: JSON.stringify(payload) }),
  getWaitingRooms: () => request('/waiting-rooms'),
  setWaitingRoom: (floor_number, location) => request('/waiting-rooms', { method: 'POST', body: JSON.stringify({ floor_number, location }) }),
  deleteWaitingRoom: (floorNumber) => request(`/waiting-rooms/${floorNumber}`, { method: 'DELETE' }),

  // users (admin)
  getUsers: (centerId) => request(`/users${qs({ center_id: centerId })}`),
  createUser: (payload) => request('/users', { method: 'POST', body: JSON.stringify(payload) }),
  updateUser: (id, payload) => request(`/users/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteUser: (id) => request(`/users/${id}`, { method: 'DELETE' }),

  // reports (admin, cached 20s server-side)
  companyStats: (centerId) => request(`/company-stats${qs({ center_id: centerId })}`),
  masterReport: (centerId) => request(`/master-report${qs({ center_id: centerId })}`),
  candidateSummary: (centerId) => request(`/candidate-summary${qs({ center_id: centerId })}`),
  ratingReport: (centerId) => request(`/rating-report${qs({ center_id: centerId })}`),
  qualDistribution: (centerId) => request(`/qual-distribution${qs({ center_id: centerId })}`),
  fieldDistribution: (centerId) => request(`/field-distribution${qs({ center_id: centerId })}`),
  getInsights: (date, centerId) => request(`/insights${qs({ date, center_id: centerId })}`),

  // centers (fair_cycle_isolation_plan.md Phase 4)
  getCenters: () => request('/centers'),
  createCenter: (payload) => request('/centers', { method: 'POST', body: JSON.stringify(payload) }),
};

// Staff-only (lib/io.js rejects anonymous connections) — same-origin via the
// Vite dev proxy's /socket.io entry, cookie carries the JWT. autoConnect is
// off so SocketContext controls the connect/disconnect lifecycle around
// auth state rather than connecting before a user is known.
export function connectSocket() {
  return io({ withCredentials: true, autoConnect: false });
}
