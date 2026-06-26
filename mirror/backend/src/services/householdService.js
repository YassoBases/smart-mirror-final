const { getDb } = require('../config/database');

async function createHousehold({ name }) {
  const db = await getDb();
  const result = await db.run('INSERT INTO households (name) VALUES (?)', name);
  return db.get('SELECT * FROM households WHERE id = ?', result.lastID);
}

async function getHousehold(id) {
  const db = await getDb();
  const household = await db.get('SELECT * FROM households WHERE id = ?', id);
  if (!household) {
    throw Object.assign(new Error('Household not found'), { status: 404 });
  }
  return household;
}

module.exports = { createHousehold, getHousehold };
