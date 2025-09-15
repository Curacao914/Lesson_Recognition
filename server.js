const WebSocket = require('ws');
const { spawn } = require('child_process');
const zlib = require('zlib');
const { v4: uuidv4 } = require('uuid');

const APP_KEY = '9154037824';
const ACCESS_KEY = 'rBl-NpaFT0TUEUKBZTD2jnTb1IpRjSPY';
const RESOURCE_ID = 'volc.bigasr.sauc.duration';
const VOLC_WS = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';

const wss = new WebSocket.Server({ port: 3000 }, () => {
  console.log('[WS] Server listening on ws://localhost:3000');
});

wss.on('connection', (client) => {
  console.log('[WS] client connected');

  let volcanoWS;
  let ffmpeg;
  let heartbeatTimer;

  function connectVolcEngine() {
    volcanoWS = new WebSocket(VOLC_WS, {
      headers: {
        'X-Api-App-Key': APP_KEY,
        'X-Api-Access-Key': ACCESS_KEY,
        'X-Api-Resource-Id': RESOURCE_ID,
        'X-Api-Connect-Id': uuidv4()
      }
    });

    volcanoWS.on('open', () => {
      console.log('[VOLC] Connected to Volc Engine');
      sendFullClientRequest();
      startHeartbeat();
    });

    volcanoWS.on('message', (msg) => {
      try {
        const data = zlib.gunzipSync(msg).toString('utf-8');
        client.send(data);
      } catch {
        client.send(msg.toString());
      }
    });

    volcanoWS.on('close', () => {
      console.log('[VOLC] disconnected');
      stopHeartbeat();
    });

    volcanoWS.on('error', (err) => {
      console.error('[VOLC] error', err);
      stopHeartbeat();
    });
  }

  function startHeartbeat() {
    heartbeatTimer = setInterval(() => {
      if (volcanoWS.readyState === WebSocket.OPEN) {
        // 发送 10ms 静音包保持会话活跃
        const silentChunk = Buffer.alloc(320, 0); // 16kHz 16bit 单声道 10ms
        sendAudioChunk(silentChunk, false);
      }
    }, 3000); // 每 3 秒发一次
  }

  function stopHeartbeat() {
    clearInterval(heartbeatTimer);
  }

  function initFFmpeg() {
    ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-f', 's16le',
      '-ac', '1',
      '-ar', '16000',
      'pipe:1'
    ]);
    ffmpeg.stderr.on('data', () => {});
    ffmpeg.on('close', () => console.log('[FFMPEG] closed'));

    ffmpeg.stdout.on('data', (chunk) => sendAudioChunk(chunk, false));
  }

  function makeHeader({ type = 0x2, flags = 0x0, serialize = 0x0, compress = 0x1 }) {
    const buf = Buffer.alloc(4);
    buf[0] = (1 << 4) | 1;
    buf[1] = (type << 4) | flags;
    buf[2] = (serialize << 4) | compress;
    buf[3] = 0;
    return buf;
  }

  function makePayloadSize(len) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(len);
    return buf;
  }

  function sendFullClientRequest() {
    const payloadJson = JSON.stringify({
      user: { uid: 'lesson_user' },
      audio: { format:'pcm', rate:16000, bits:16, channel:1, language:'zh-CN' },
      request: { model_name:'bigmodel', enable_itn:true, enable_punc:true }
    });

    const payloadGzip = zlib.gzipSync(Buffer.from(payloadJson, 'utf8'));
    const header = makeHeader({ type: 0x1, flags:0x0, serialize:0x1, compress:0x1 });
    const sizeBuf = makePayloadSize(payloadGzip.length);
    volcanoWS.send(Buffer.concat([header, sizeBuf, payloadGzip]));
  }

  function sendAudioChunk(chunk, isLast = false) {
    const flags = isLast ? 0x2 : 0x0;
    const header = makeHeader({ type:0x2, flags, serialize:0x0, compress:0x1 });
    const gz = zlib.gzipSync(chunk);
    const sizeBuf = makePayloadSize(gz.length);
    if (volcanoWS.readyState === WebSocket.OPEN) {
      volcanoWS.send(Buffer.concat([header, sizeBuf, gz]));
    }
  }

  connectVolcEngine();
  initFFmpeg();

  client.on('message', (msg) => {
    if (msg.length === 0) return;
    if (ffmpeg && ffmpeg.stdin.writable) ffmpeg.stdin.write(msg);
  });

  client.on('close', () => {
    console.log('[WS] client disconnected');
    if (ffmpeg) ffmpeg.stdin.end();
    sendAudioChunk(Buffer.alloc(0), true);
    if (volcanoWS) volcanoWS.close();
  });
});
