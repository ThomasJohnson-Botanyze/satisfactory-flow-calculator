// Read-only CDP probe: connect to a running app instance and report what the
// renderer actually loaded (plan names, store sources, api bridge presence).
// Usage: node scripts/cdp-peek.js [port] ["expression"]
const http = require('http');

const port = process.argv[2] || '9223';
const expr = process.argv[3] || `JSON.stringify({
  plansCount: (typeof plans !== 'undefined') ? plans.length : 'no-global',
  planNames: (typeof plans !== 'undefined') ? plans.map(p => p.name) : null,
  projects: (typeof projects !== 'undefined') ? projects.map(p => p.name) : null,
  apiPresent: typeof api !== 'undefined' && !!api,
  apiLoadPlans: (typeof api !== 'undefined' && api && api.loadPlans) ? 'fn' : 'missing',
  fileRead: (() => { try { const r = (typeof api !== 'undefined' && api && api.loadPlans) ? api.loadPlans() : null; if (!r) return 'null'; const j = JSON.parse(r); return 'plans=' + (j.plans||[]).length + ' savedAt=' + j.savedAt; } catch (e) { return 'ERR ' + e.message; } })(),
  lsPlans: (() => { try { const r = localStorage.getItem('satisfactory-factory-plans-v1'); if (!r) return 'null'; const j = JSON.parse(r); return 'plans=' + (j.plans||[]).length + ' savedAt=' + j.savedAt; } catch (e) { return 'ERR ' + e.message; } })(),
  lsLegacy: (() => { try { return localStorage.getItem('satisfactory-flow-plan-v3') ? 'present' : 'null'; } catch (e) { return 'ERR'; } })(),
})`;

http.get(`http://127.0.0.1:${port}/json`, (res) => {
  let body = '';
  res.on('data', (c) => body += c);
  res.on('end', () => {
    const targets = JSON.parse(body);
    const page = targets.find(t => t.type === 'page');
    if (!page) { console.error('no page target'); process.exit(1); }
    const wsUrl = page.webSocketDebuggerUrl;
    // Minimal WebSocket client (no deps): single Runtime.evaluate round-trip.
    const crypto = require('crypto');
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
      },
    });
    req.end();
    req.on('upgrade', (res2, socket) => {
      const msg = JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } });
      // Build a masked client frame (RFC 6455).
      const payload = Buffer.from(msg);
      const mask = crypto.randomBytes(4);
      const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
      let header;
      if (payload.length < 126) {
        header = Buffer.from([0x81, 0x80 | payload.length]);
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      socket.write(Buffer.concat([header, mask, masked]));
      let buf = Buffer.alloc(0);
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        // Parse one unmasked server frame (possibly fragmented at TCP level).
        if (buf.length < 2) return;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const frame = buf.slice(off, off + len).toString();
        try {
          const out = JSON.parse(frame);
          const v = out.result && out.result.result && out.result.result.value;
          console.log(typeof v === 'string' ? v : JSON.stringify(out));
        } catch (e) { console.log(frame); }
        socket.end(); process.exit(0);
      });
      setTimeout(() => { console.error('timeout'); process.exit(2); }, 8000);
    });
    req.on('error', (e) => { console.error('req err ' + e.message); process.exit(3); });
  });
}).on('error', (e) => { console.error('http err ' + e.message); process.exit(4); });
