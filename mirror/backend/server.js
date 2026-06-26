require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const app = require('./src/app');
const mirrorSync = require('./src/services/mirrorSync');

const PORT    = process.env.PORT    || 3000;
const WS_PORT = process.env.WS_PORT || 4000;

// Bind to 0.0.0.0 so the backend is reachable from both:
//   - the mirror UI on the same machine (127.0.0.1)
//   - the Flutter phone app on the same WiFi network (LAN IP)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Smart Mirror Backend running on http://0.0.0.0:${PORT}`);
});

mirrorSync.start(WS_PORT);