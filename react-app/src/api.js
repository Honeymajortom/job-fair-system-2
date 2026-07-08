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

export const api = {
  // public candidate path
  qrCompanies: () => request('/qr/companies'),
  qrRegister: (payload) => request('/qr/register', { method: 'POST', body: JSON.stringify(payload) }),
  qrSchedule: (token) => request(`/qr/schedule/${token}`),

  // auth
  login: (username, password) => request('/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  me: () => request('/me'),
  logout: () => request('/logout', { method: 'POST' }),

  // staff
  getCompanies: () => request('/companies'),
  getCompany: (id) => request(`/companies/${id}`),
  createCompany: (payload) => request('/companies', { method: 'POST', body: JSON.stringify(payload) }),
  addRatingParameter: (id, payload) => request(`/companies/${id}/rating-parameters`, { method: 'POST', body: JSON.stringify(payload) }),
  generateSlots: (payload) => request('/slots/generate', { method: 'POST', body: JSON.stringify(payload) }),
  register: (payload) => request('/register', { method: 'POST', body: JSON.stringify(payload) }),
  listCandidates: () => request('/candidates'),
  getCandidate: (token) => request(`/candidates/${token}`),
  rescheduleBatch: (id, batch_id) => request(`/candidates/${id}/batch`, { method: 'PUT', body: JSON.stringify({ batch_id }) }),
  getQueue: (companyId) => request(`/queue/${companyId}`),
  submitResult: (payload) => request('/interview-result', { method: 'PUT', body: JSON.stringify(payload) }),
  markNoShow: (payload) => request('/no-show', { method: 'POST', body: JSON.stringify(payload) }),
  getStats: () => request('/stats'),
  getBatches: () => request('/batches'),
  setBatchStatus: (id, status) => request(`/batch/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
  checkIn: (batchId, payload) => request(`/batch/${batchId}/check-in`, { method: 'POST', body: JSON.stringify(payload) }),
  qrToken: () => request('/qr/token'),

  // fair config (admin)
  getFairSettings: () => request('/fair-settings'),
  createFairSettings: (payload) => request('/fair-settings', { method: 'POST', body: JSON.stringify(payload) }),
  generateBatches: (payload) => request('/batches/generate', { method: 'POST', body: JSON.stringify(payload) }),

  // users (admin)
  getUsers: () => request('/users'),
  createUser: (payload) => request('/users', { method: 'POST', body: JSON.stringify(payload) }),
  deleteUser: (id) => request(`/users/${id}`, { method: 'DELETE' }),

  // reports (admin, cached 20s server-side)
  companyStats: () => request('/company-stats'),
  masterReport: () => request('/master-report'),
  candidateSummary: () => request('/candidate-summary'),
  ratingReport: () => request('/rating-report'),
  qualDistribution: () => request('/qual-distribution'),
  fieldDistribution: () => request('/field-distribution'),
};
