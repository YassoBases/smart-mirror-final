const router = require('express').Router();
const gmailController = require('../controllers/gmailController');

// Google redirects here after the user approves — no JWT, called directly by Google
router.get('/callback', gmailController.callback);

module.exports = router;
