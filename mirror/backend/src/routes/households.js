const router = require('express').Router();
const householdController = require('../controllers/householdController');
const { authenticate } = require('../middleware/auth');

// POST /api/households — public, because the household must exist before any account can register
router.post('/', householdController.create);

// GET /api/households/:id — requires auth
router.get('/:id', authenticate, householdController.getOne);

module.exports = router;
