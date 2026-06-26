const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../config/database');

async function registerAccount({ householdId, email, password }) {
  const db = await getDb();

  const existing = await db.get('SELECT id FROM accounts WHERE email = ?', email);
  if (existing) {
    throw Object.assign(new Error('Email already registered'), { status: 409 });
  }

  const household = await db.get('SELECT id FROM households WHERE id = ?', householdId);
  if (!household) {
    throw Object.assign(new Error('Household not found'), { status: 404 });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const result = await db.run(
    'INSERT INTO accounts (household_id, email, password_hash) VALUES (?, ?, ?)',
    householdId, email, passwordHash
  );

  return { id: result.lastID, householdId, email };
}

async function loginAccount({ email, password }) {
  const db = await getDb();

  const account = await db.get('SELECT * FROM accounts WHERE email = ?', email);

  // Always run compare to prevent timing-based user enumeration
  const hash = account ? account.password_hash : '$2a$12$invalidhashpadding000000000000000000000000000000000000';
  const valid = await bcrypt.compare(password, hash);

  if (!account || !valid) {
    throw Object.assign(new Error('Invalid email or password'), { status: 401 });
  }

  const token = jwt.sign(
    { accountId: account.id, householdId: account.household_id, email: account.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

  return {
    token,
    account: { id: account.id, householdId: account.household_id, email: account.email },
  };
}

module.exports = { registerAccount, loginAccount };
