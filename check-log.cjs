'use strict';
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, 'cline-patch-log.txt');
if (!fs.existsSync(p)) { console.log('NO LOG FILE'); process.exit(0); }
const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
console.log('entries:', lines.length);
lines.forEach((l, i) => {
  try {
    const o = JSON.parse(l);
    console.log('[' + i + ']', o.ts, 'pid=' + o.pid, 'ok=' + o.ok, 'marker=' + o.marker, 'err=' + (o.error || '-'));
    console.log('      argv:', (o.argv || '').slice(0, 300));
  } catch (e) {
    console.log('[' + i + '] unparseable:', l.slice(0, 120));
  }
});
