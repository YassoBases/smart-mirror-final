const express = require('express');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const router = express.Router();

// Allowlist of RSS feed domains — prevents open-proxy abuse
const ALLOWED_HOSTS = [
  'feeds.bbci.co.uk',
  'www.aljazeera.com',
  'www.trtworld.com',
  'www.turkishminute.com',
];

/**
 * GET /api/news/rss?url=<encoded_rss_url>
 * Server-side RSS proxy — fetches the feed and pipes raw XML back to the client.
 * No auth required; restricted to the ALLOWED_HOSTS allowlist.
 */
router.get('/rss', (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    return res.status(403).json({ error: 'Host not in allowlist' });
  }

  const lib = parsed.protocol === 'https:' ? https : http;

  const request = lib.get(
    rawUrl,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SmartMirror/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
      timeout: 10000,
    },
    (upstream) => {
      // Follow one redirect
      if (
        (upstream.statusCode === 301 || upstream.statusCode === 302) &&
        upstream.headers.location
      ) {
        let redirectUrl;
        try {
          redirectUrl = new URL(upstream.headers.location, rawUrl);
        } catch {
          return res.status(502).json({ error: 'Bad redirect URL' });
        }
        if (!ALLOWED_HOSTS.includes(redirectUrl.hostname)) {
          return res.status(403).json({ error: 'Redirect host not in allowlist' });
        }
        upstream.resume();
        const lib2 = redirectUrl.protocol === 'https:' ? https : http;
        lib2.get(
          redirectUrl.toString(),
          { headers: request.getHeader ? {} : {}, timeout: 10000 },
          (r2) => {
            res.setHeader('Content-Type', 'application/xml; charset=utf-8');
            res.setHeader('Cache-Control', 'public, max-age=120');
            r2.pipe(res);
          }
        ).on('error', () => res.status(502).json({ error: 'Redirect fetch failed' }));
        return;
      }

      if (upstream.statusCode !== 200) {
        return res.status(502).json({ error: `Upstream HTTP ${upstream.statusCode}` });
      }

      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=120');
      upstream.pipe(res);
    }
  );

  request.on('error', (err) => {
    if (!res.headersSent) res.status(502).json({ error: err.message });
  });

  request.on('timeout', () => {
    request.destroy();
    if (!res.headersSent) res.status(504).json({ error: 'Upstream timeout' });
  });
});

module.exports = router;
