const router = require('express').Router();
const fs = require('fs');
const { execFile } = require('child_process');
const { authenticate } = require('../middleware/auth');

// "Change WiFi" support. The backend runs as a non-root user and must NOT have
// any privilege to manage systemd units. Instead it drops a sentinel file that a
// root-owned systemd .path unit watches; that unit starts the BLE re-provisioning
// service for us. Reading unit state (`systemctl is-active`) needs no privilege.
//
// See provisioning/smartmirror-ble-reprovision-trigger.{path,service} and the
// /run/smartmirror tmpfiles entry, all installed by provisioning/install.sh.

const REQUEST_FILE = '/run/smartmirror/reprovision-request';
const SYSTEMCTL = '/usr/bin/systemctl';
const UNIT = 'smartmirror-ble-reprovision.service';

// POST /api/provisioning/reprovision — request BLE WiFi setup mode.
router.post('/reprovision', authenticate, (_req, res, next) => {
  fs.writeFile(REQUEST_FILE, `${Date.now()}\n`, (err) => {
    if (err) {
      return next(new Error(
        'Could not request WiFi setup mode (is the reprovision trigger ' +
        'installed?): ' + err.message));
    }
    res.json({ ok: true, requested: true });
  });
});

// GET /api/provisioning/status — whether the mirror is currently advertising.
// `systemctl is-active` is an unprivileged read, so no escalation is needed.
router.get('/status', authenticate, (_req, res) => {
  execFile(SYSTEMCTL, ['is-active', UNIT], { timeout: 5000 }, (_err, stdout) => {
    const state = (stdout || '').trim() || 'inactive';
    res.json({ advertising: state === 'active', state });
  });
});

module.exports = router;
