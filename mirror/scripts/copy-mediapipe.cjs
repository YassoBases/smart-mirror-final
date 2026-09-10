// Build-time asset copy only. Models/WASM are served locally in the kiosk.
const fs = require('fs');
const path = require('path');
for (const model of ['hands', 'pose']) {
  const source = path.dirname(require.resolve(`@mediapipe/${model}/package.json`));
  const dest = path.join(__dirname, '..', 'public', 'mediapipe', model);
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(source)) {
    if (/\.(js|wasm|data|tflite|binarypb)$/.test(name)) fs.copyFileSync(path.join(source,name),path.join(dest,name));
  }
}
