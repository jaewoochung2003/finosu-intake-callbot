// server.js — the number answers here.
//
// Two endpoints and nothing else. Twilio POSTs to /incoming-call when the phone
// rings and gets back TwiML that opens a two-way audio socket to /media-stream;
// bridge.js owns everything after that.
//
//   node src/server.js
//
// The public URL Twilio points at has to be HTTPS/WSS, which on a laptop means a
// tunnel. See README for the cloudflared line.

require('./env');

const http = require('http');
const { WebSocketServer } = require('ws');
const { handleCall } = require('./bridge');

const PORT = Number(process.env.PORT || 5050);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// Twilio or SignalWire. SignalWire speaks the same markup and the same stream
// protocol, down to the event names and the shape of every frame, so the bridge
// cannot tell the two apart and nothing below this file changes. Two attributes
// differ: SignalWire wants the codec named, and it paces a bidirectional stream
// only when asked. Twilio rejects both attributes, so the markup is not shared.
const CARRIER = (process.env.CARRIER || 'twilio').toLowerCase();

// The caller's number rides along as a custom parameter; both carriers deliver it in
// the stream's start message, which is the only place the socket can learn who
// called.
function twiml(host, from, carrier = CARRIER) {
  const attr = String(from || '').replace(/[<>&"]/g, '');
  // No realtime="true" on the SignalWire stream. In that mode it paces playback
  // against a clock and drops whatever arrives ahead of it, and the model writes a
  // sentence far faster than a sentence takes to say, so the tail of every line was
  // thrown away. Buffered, the default, plays all of it.
  const stream =
    carrier === 'signalwire'
      ? `<Stream url="wss://${host}/media-stream" codec="PCMU@8000h">`
      : `<Stream url="wss://${host}/media-stream">`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    ${stream}
      <Parameter name="from" value="${attr}" />
    </Stream>
  </Connect>
</Response>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime',
        carrier: CARRIER,
      }),
    );
    return;
  }

  // Twilio POSTs here on an inbound call. GET is allowed too so the URL can be
  // opened in a browser to check the tunnel is up.
  if (url.pathname === '/incoming-call') {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const from = new URLSearchParams(body).get('From');
      console.log('incoming call from', from || 'unknown');
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(twiml(host, from));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname !== '/media-stream') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    handleCall(ws, { openaiApiKey: OPENAI_API_KEY });
  });
});

// Required by a test rather than run: hand back the pieces and start nothing.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`callbot listening on :${PORT} (carrier: ${CARRIER})`);
    console.log(`  Voice webhook -> https://<your-tunnel-host>/incoming-call`);
  });
}

module.exports = { server, twiml, CARRIER };
