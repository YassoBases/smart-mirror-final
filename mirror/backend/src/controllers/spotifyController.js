const spotifyService = require('../services/spotifyService');
const profileService = require('../services/profileService');

// GET /api/profiles/:id/spotify/connect
// Returns the Spotify OAuth URL for this profile
async function connect(req, res, next) {
  try {
    const profileId = Number(req.params.id);
    const profile = await profileService.getProfile(profileId);
    if (profile.household_id !== req.account.householdId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const url = spotifyService.getAuthUrl(profileId);
    res.json({ url });
  } catch (err) {
    next(err);
  }
}

// GET /api/spotify/callback  (called by Spotify — no JWT)
async function callback(req, res, next) {
  try {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`Spotify error: ${error}`);
    if (!code || !state) return res.status(400).send('Missing code or state');

    const profileId = Number(state);
    if (!profileId) return res.status(400).send('Invalid state');

    const result = await spotifyService.handleCallback(code, profileId);
    // Simple success page — user taps "Done" in the app dialog
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#191414;color:#fff">
        <h2 style="color:#1DB954">&#10003; Spotify Connected</h2>
        <p>Welcome, <strong>${result.displayName}</strong>!</p>
        <p style="color:#aaa">You can close this tab and return to the app.</p>
      </body></html>
    `);
  } catch (err) {
    next(err);
  }
}

// POST /api/profiles/:id/spotify/exchange
// Called by the mobile app after it receives the deep-link code via smartmirror://
async function exchange(req, res, next) {
  try {
    const profileId = Number(req.params.id);
    const profile = await profileService.getProfile(profileId);
    if (profile.household_id !== req.account.householdId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Missing code' });

    const result = await spotifyService.handleCallback(code, profileId);
    res.json({ displayName: result.displayName });
  } catch (err) {
    next(err);
  }
}

// GET /api/profiles/:id/spotify/status
async function status(req, res, next) {
  try {
    const profileId = Number(req.params.id);
    const profile = await profileService.getProfile(profileId);
    if (profile.household_id !== req.account.householdId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const s = await spotifyService.getStatus(profileId);
    res.json(s);
  } catch (err) {
    next(err);
  }
}

// DELETE /api/profiles/:id/spotify
async function disconnect(req, res, next) {
  try {
    const profileId = Number(req.params.id);
    const profile = await profileService.getProfile(profileId);
    if (profile.household_id !== req.account.householdId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await spotifyService.disconnect(profileId);
    res.json({ message: 'Spotify disconnected' });
  } catch (err) {
    next(err);
  }
}

module.exports = { connect, callback, exchange, status, disconnect };
