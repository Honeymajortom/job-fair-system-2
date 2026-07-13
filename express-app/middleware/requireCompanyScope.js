// Red-team finding H3: company_hr accounts had no company boundary — any HR
// credential could act on any company's queue by supplying a different
// company_id in the request. Mount after authenticateJWT + requireRole.
// getCompanyId(req) reads the target company_id from params/body/query
// (route-specific); every role other than company_hr keeps the fair-wide
// access it always had.
module.exports = (getCompanyId) => (req, res, next) => {
  if (req.user.role !== 'company_hr') return next();
  const companyId = getCompanyId(req);
  if (companyId == null || Number(companyId) !== Number(req.user.company_id)) {
    return res.status(403).json({ error: 'You do not have access to this company' });
  }
  next();
};
