const { spawn } = require('child_process');

// Clean Railway entrypoint: server.js is already the canonical runtime.
// Do not download/execute legacy patch scripts at boot; doing so can make
// deployments fail before the HTTP health endpoint starts.
console.log('HOMESTRO BOOTSTRAP START v4');

const child = spawn(process.execPath, ['./server.js'], {
  stdio: 'inherit',
  env: process.env
});

child.on('error', (err) => {
  console.error('HOMESTRO SERVER SPAWN FAILED', err);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`HOMESTRO SERVER EXITED BY SIGNAL ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
