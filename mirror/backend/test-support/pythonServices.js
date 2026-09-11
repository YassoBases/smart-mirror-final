const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const children = [];
const logs = [];
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
async function startService(name, module) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mirror-${name}-`));
  const log = path.join(dir, 'service.log'); logs.push(log);
  const fd = fs.openSync(log, 'w');
  const child = spawn(process.env.TEST_PYTHON || 'python', ['-m', 'uvicorn', `${module}:app`, '--host', '127.0.0.1', '--port', String(port)], {
    cwd: path.resolve(__dirname, '../../services', name), windowsHide: true,
    env: { ...process.env, MODELS_DIR: path.join(dir, 'models'), OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2' },
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd); children.push(child);
  let failed;
  child.on('error', error => { failed = error; });
  const url = `http://127.0.0.1:${port}`;
  const end = Date.now() + 180000;
  while (Date.now() < end) {
    if (failed || child.exitCode !== null) throw new Error(`${name} failed: ${failed || fs.readFileSync(log, 'utf8')}`);
    try { if ((await fetch(`${url}/health`)).ok) return url; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${name} startup timed out; ${log}`);
}
async function stopServices() {
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve); child.kill();
  })));
  console.log('Python service logs:', logs);
}
module.exports = { startService, stopServices };
