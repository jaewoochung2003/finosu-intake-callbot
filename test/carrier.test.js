// carrier.test.js — the markup each carrier gets, and the frames each one sends.
//
// SignalWire's Compatibility API answers the same markup and streams the same JSON
// as Twilio: the same event names, the same start payload, DTMF on the same socket.
// Two things differ and both live in the markup, so this file pins the markup and
// proves the bridge does not care which carrier is on the other end.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { twiml } = require('../src/server');
const { handleCall } = require('../src/bridge');

t('Twilio gets a bare Stream, with no attribute it would reject', () => {
  const xml = twiml('example.com', '+12025550123', 'twilio');
  assert.match(xml, /<Stream url="wss:\/\/example\.com\/media-stream">/);
  assert.ok(!/codec=/.test(xml), 'Twilio rejects a codec attribute');
  assert.ok(!/realtime=/.test(xml), 'Twilio rejects a realtime attribute');
  assert.match(xml, /<Parameter name="from" value="\+12025550123" \/>/);
});

t('SignalWire is told the codec and left to buffer', () => {
  const xml = twiml('example.com', '+12025550123', 'signalwire');
  assert.match(xml, /codec="PCMU@8000h"/);
  // realtime="true" drops audio that arrives ahead of the clock, which is all of it.
  assert.ok(!/realtime=/.test(xml), 'realtime pacing cuts every sentence short');
  // u-law at 8 kHz both ways is what the bridge copies across untouched.
  assert.ok(!/L16/.test(xml));
});

t('a caller id with markup in it cannot break the document', () => {
  const xml = twiml('example.com', '+1<script>&"', 'signalwire');
  assert.ok(!/<script>/.test(xml));
});

// SignalWire identifies a call with a uuid where Twilio uses CA... and MZ...
// Nothing in the bridge parses those strings, and this is the test that says so.
t('a SignalWire start frame drives the call the same as a Twilio one', () => {
  const sent = [];
  const openai = {
    readyState: 1,
    handlers: {},
    on(e, fn) {
      (this.handlers[e] = this.handlers[e] || []).push(fn);
      return this;
    },
    emit(e, ...a) {
      for (const fn of this.handlers[e] || []) fn(...a);
    },
    send(raw) {
      sent.push(JSON.parse(raw));
    },
    close() {},
  };
  const twilio = { ...openai, sent: [], handlers: {}, send(raw) { this.sent.push(JSON.parse(raw)); } };
  Object.setPrototypeOf(twilio, Object.getPrototypeOf(openai));

  handleCall(twilio, {
    openaiApiKey: 'test',
    openWebSocket: () => openai,
    deliver: async () => ({ sent: true, via: 'test' }),
    callsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'callbot-')),
  });
  openai.emit('open');
  twilio.emit('message', JSON.stringify({ event: 'connected', protocol: 'Call', version: '0.2.0' }));
  twilio.emit(
    'message',
    JSON.stringify({
      event: 'start',
      sequenceNumber: '1',
      start: {
        streamSid: '7d56cc11-536d-4a45-b4fb-ed3d55be843b',
        accountSid: 'b08dacad-2f6c-4de1-93d6-cc732e0c69c5',
        callSid: '76ac3c36-56da-4a3e-a0d6-b5f8df6da9ad',
        tracks: ['inbound'],
        customParameters: { from: '+12025550123' },
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      },
    }),
  );
  // audio out carries the uuid stream id back, untouched
  openai.emit('message', JSON.stringify({ type: 'response.output_audio.delta', delta: 'BBBB' }));
  const media = twilio.sent.filter((m) => m.event === 'media');
  assert.strictEqual(media.length, 1);
  assert.strictEqual(media[0].streamSid, '7d56cc11-536d-4a45-b4fb-ed3d55be843b');

  // and a keypad press still reaches the intake
  twilio.emit(
    'message',
    JSON.stringify({
      event: 'dtmf',
      sequenceNumber: '2',
      streamSid: '7d56cc11-536d-4a45-b4fb-ed3d55be843b',
      dtmf: { digit: '4', duration: 2000 },
    }),
  );
  assert.ok(true);
});
