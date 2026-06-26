const authService = require('../services/authService');

async function register(req, res, next) {
  try {
    const { householdId, email, password } = req.body;

    if (!householdId || !email || !password) {
      return res.status(400).json({ error: 'householdId, email, and password are required' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const account = await authService.registerAccount({ householdId, email, password });
    res.status(201).json({ account });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const result = await authService.loginAccount({ email, password });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login };
