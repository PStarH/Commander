const test = require('node:test');
const path = require('node:path');
const { startServer, stopServer } = require('./_helpers/spawnServer');

let serverContext;

test.before(async () => {
  console.log('[debug] before start');
  serverContext = await startServer(path.resolve(__dirname, '..'));
  console.log('[debug] started', serverContext.baseUrl);
});

test.after(async () => {
  console.log('[debug] after');
  if (serverContext) {
    await stopServer(serverContext);
    console.log('[debug] stopped');
  }
});

test('server health', async () => {
  console.log('[debug] health check');
  const res = await fetch(`${serverContext.baseUrl}/health`);
  console.log('[debug] health status', res.status);
});
