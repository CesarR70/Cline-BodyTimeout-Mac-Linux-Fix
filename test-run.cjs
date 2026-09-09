'use strict';
// Real HTTP stream with an idle gap: no Ollama/model or five-minute wait needed.
const assert = require('assert/strict');
const http = require('http');
const { once } = require('events');
const undici = require('undici');

async function main() {
  const mode = process.argv[2];
  assert.ok(mode === 'timeout4000' || mode === 'timeout0', 'Unknown test mode');
  const expectedTimeout = mode === 'timeout4000';
  assert.equal(globalThis.__OLLAMA_TIMEOUT_FIX__?.loaded, true);
  assert.equal(globalThis.__OLLAMA_TIMEOUT_FIX__.bodyTimeout, expectedTimeout ? 4000 : 0);
  const timers = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('before thinking\n');
    const timer = setTimeout(() => res.end('after thinking\n'), 15000);
    timers.add(timer);
    res.on('close', () => { clearTimeout(timer); timers.delete(timer); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  try {
    const start = Date.now();
    const response = await fetch(url);
    if (expectedTimeout) {
      await assert.rejects(response.text(), (error) => error.cause?.code === 'UND_ERR_BODY_TIMEOUT');
      assert.ok(Date.now() - start < 15000, 'Must fail before the server resumes');
      console.log('PASS: configured 4-second timeout aborts the stalled body.');
    } else {
      assert.equal(await response.text(), 'before thinking\nafter thinking\n');
      assert.ok(Date.now() - start >= 14000, 'Must actually survive the idle gap');
      console.log('PASS: zero timeout survives the 15-second body stall.');
    }
  } finally {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await undici.getGlobalDispatcher().close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });