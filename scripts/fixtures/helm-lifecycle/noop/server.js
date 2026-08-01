const http = require('http');

function handler(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', path: req.url }));
}

const ports = [4000, 8081, 8082, 8083, 9443];
for (const port of ports) {
  const server = http.createServer(handler);
  server.listen(port, '0.0.0.0', () => {
    process.stdout.write(`noop server listening on ${port}\n`);
  });
}
