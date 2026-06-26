const householdService = require('../services/householdService');

async function create(req, res, next) {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Household name is required' });
    }

    const household = await householdService.createHousehold({ name: name.trim() });
    res.status(201).json({ household });
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const household = await householdService.getHousehold(Number(req.params.id));
    res.json({ household });
  } catch (err) {
    next(err);
  }
}

module.exports = { create, getOne };
