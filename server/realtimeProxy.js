import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const PORT = process.env.WS_PROXY_PORT ? Number(process.env.WS_PROXY_PORT) : 3301;
const MODEL = process.env.QWEN_REALTIME_MODEL || 'qwen3-omni-flash-realtime';
const REGION = process.env.DASHSCOPE_REGION || 'cn';
const BASE = REGION === 'intl' ? 'wss://dashscope-intl.aliyuncs.com' : 'wss://dashscope.aliyuncs.com';
const TARGET = `${BASE}/api-ws/v1/realtime?model=${encodeURIComponent(MODEL)}`;
const API_KEY = process.env.DASHSCOPE_API_KEY;

if (!API_KEY) {
  console.error('Missing DASHSCOPE_API_KEY');
  process.exit(1);
}

const wss = new WebSocketServer({ port: PORT, path: '/realtime' });

wss.on('connection', (client) => {
  const upstream = new WebSocket(TARGET, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });

  upstream.on('open', () => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'proxy.upstream_open' }));
    }
  });

  upstream.on('message', (data) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });

  upstream.on('close', (code, reason) => {
    if (client.readyState === WebSocket.OPEN) {
      client.close(code, reason.toString());
    }
  });

  upstream.on('error', (err) => {
    try {
      client.send(JSON.stringify({ type: 'proxy.error', error: err?.message || 'upstream error' }));
    } catch {}
    client.close();
  });

  client.on('message', (data) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data);
    }
  });

  client.on('close', () => {
    try { upstream.close(); } catch {}
  });
});

console.log(`Qwen Realtime WS proxy listening on ws://localhost:${PORT}/realtime -> ${TARGET}`);
