const gmailService = require('../services/gmailService');
const profileService = require('../services/profileService');

async function connect(req, res, next) {
  try {
    const profileId = Number(req.params.id);
    const profile = await profileService.getProfile(profileId);

    if (profile.household_id !== req.account.householdId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const url = gmailService.getAuthUrl(profileId);
    res.json({ url });
  } catch (err) {
    next(err);
  }
}

async function callback(req, res, next) {
  try {
    const { code, state, error } = req.query;

    if (error) {
      const query = new URLSearchParams({ error: `Google OAuth error: ${error}` }).toString();
      return res.redirect(`smartmirror://oauth?${query}`);
    }
    if (!code || !state) {
      const query = new URLSearchParams({ error: 'Missing code or state parameter' }).toString();
      return res.redirect(`smartmirror://oauth?${query}`);
    }

    const profileId = Number(state);
    if (!profileId) {
      const query = new URLSearchParams({ error: 'Invalid state parameter' }).toString();
      return res.redirect(`smartmirror://oauth?${query}`);
    }

    await gmailService.handleCallback(code, profileId);
    return res.redirect('smartmirror://oauth?status=connected');
  } catch (err) {
    next(err);
  }
}

async function messages(req, res, next) {
  try {
    const profileId = Number(req.params.id);
    const profile = await profileService.getProfile(profileId);

    if (profile.household_id !== req.account.householdId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const inbox = await gmailService.getInboxSummary(profileId);
    res.json({ messages: inbox });
  } catch (err) {
    next(err);
  }
}

async function disconnect(req, res, next) {
  try {
    const profileId = Number(req.params.id);
    const profile = await profileService.getProfile(profileId);

    if (profile.household_id !== req.account.householdId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await gmailService.disconnectGmail(profileId);
    res.json({ message: 'Gmail disconnected' });
  } catch (err) {
    next(err);
  }
}

module.exports = { connect, callback, messages, disconnect };
