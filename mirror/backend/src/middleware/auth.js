const jwt = require('jsonwebtoken');

/**
 * Express middleware that validates a Bearer JWT.
 * On success it attaches the decoded payload to req.account so controllers
 * can read req.account.accountId and req.account.householdId without hitting the DB.
 */
function authenticate(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = header.split(' ')[1];

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.account = payload; // { accountId, householdId, email, iat, exp }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { authenticate };
