import { io } from 'socket.io-client';

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
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  // public candidate path
  qrCompanies: () => request('/qr/companies'),
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
  recoverToken: (payload) => request('/qr/recover', { method: 'POST', body: JSON.stringify(payload) }),
  // qr here is the same signed "{token_no}.{HMAC}" string uploadResume uses,
  // not the bare token — see routes/public.js POST /qr/feedback/:qr.
  submitFeedback: (qr, payload) => request(`/qr/feedback/${encodeURIComponent(qr)}`, { method: 'POST', body: JSON.stringify(payload) }),
  getGateStatus: () => request('/gate-status'),

  // auth
  login: (username, password) => request('/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  me: () => request('/me'),
  logout: () => request('/logout', { method: 'POST' }),

  // staff
  getCompanies: () => request('/companies'),
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
  listCandidates: (date) => request(`/candidates${date ? `?date=${date}` : ''}`),
  getCandidate: (token) => request(`/candidates/${token}`),
  rescheduleBatch: (id, batch_id) => request(`/candidates/${id}/batch`, { method: 'PUT', body: JSON.stringify({ batch_id }) }),
  getQueue: (companyId) => request(`/queue/${companyId}`),
  submitResult: (payload) => request('/interview-result', { method: 'PUT', body: JSON.stringify(payload) }),
  markNoShow: (payload) => request('/no-show', { method: 'POST', body: JSON.stringify(payload) }),
  // queue-system Phase 3/4 — desk tablet
  getDeskOccupant: (companyId, deskId) => request(`/queue/desk/${companyId}/${deskId}`),
  deskNext: (payload) => request('/queue/desk/next', { method: 'POST', body: JSON.stringify(payload) }),
  confirmArrival: (payload) => request('/queue/confirm-arrival', { method: 'POST', body: JSON.stringify(payload) }),
  pauseArrival: (payload) => request('/queue/pause-arrival', { method: 'POST', body: JSON.stringify(payload) }),
  resumeArrival: (payload) => request('/queue/resume-arrival', { method: 'POST', body: JSON.stringify(payload) }),
  getStats: () => request('/stats'),
  getFloorStats: (date) => request(`/floor-stats${date ? `?date=${date}` : ''}`),
  getBatches: () => request('/batches'),
  setBatchStatus: (id, status) => request(`/batch/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
  checkIn: (payload) => request('/batch/check-in', { method: 'POST', body: JSON.stringify(payload) }),
  exitCandidate: (payload) => request('/candidates/exit', { method: 'POST', body: JSON.stringify(payload) }),
  qrToken: () => request('/qr/token'),

  // fair config (admin)
  getFairSettings: () => request('/fair-settings'),
  createFairSettings: (payload) => request('/fair-settings', { method: 'POST', body: JSON.stringify(payload) }),
  updateFairSettings: (id, payload) => request(`/fair-settings/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  generateBatches: (payload) => request('/batches/generate', { method: 'POST', body: JSON.stringify(payload) }),
  getWaitingRooms: () => request('/waiting-rooms'),
  setWaitingRoom: (floor_number, location) => request('/waiting-rooms', { method: 'POST', body: JSON.stringify({ floor_number, location }) }),
  deleteWaitingRoom: (floorNumber) => request(`/waiting-rooms/${floorNumber}`, { method: 'DELETE' }),

  // users (admin)
  getUsers: () => request('/users'),
  createUser: (payload) => request('/users', { method: 'POST', body: JSON.stringify(payload) }),
  updateUser: (id, payload) => request(`/users/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteUser: (id) => request(`/users/${id}`, { method: 'DELETE' }),

  // reports (admin, cached 20s server-side)
  companyStats: () => request('/company-stats'),
  masterReport: () => request('/master-report'),
  candidateSummary: () => request('/candidate-summary'),
  ratingReport: () => request('/rating-report'),
  qualDistribution: () => request('/qual-distribution'),
  fieldDistribution: () => request('/field-distribution'),
  getInsights: (date) => request(`/insights${date ? `?date=${date}` : ''}`),
};

// Staff-only (lib/io.js rejects anonymous connections) — same-origin via the
// Vite dev proxy's /socket.io entry, cookie carries the JWT. autoConnect is
// off so SocketContext controls the connect/disconnect lifecycle around
// auth state rather than connecting before a user is known.
export function connectSocket() {
  return io({ withCredentials: true, autoConnect: false });
}
