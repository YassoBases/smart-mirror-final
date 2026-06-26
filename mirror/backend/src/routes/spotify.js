const router = require('express').Router();
const spotifyController = require('../controllers/spotifyController');

// Spotify redirects here after user approves — no JWT, called directly by Spotify
router.get('/callback', spotifyController.callback);

module.exports = router;
