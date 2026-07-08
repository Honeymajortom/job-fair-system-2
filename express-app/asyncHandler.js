// Express 4 does not forward rejected promises from async handlers to the
// error middleware on its own — wrap every route so a thrown/rejected error
// reaches app.use((err, req, res, next) => ...) instead of hanging the request.
module.exports = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
