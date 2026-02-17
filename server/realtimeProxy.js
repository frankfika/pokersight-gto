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
  console.log('[Proxy] Client connected, connecting upstream to', TARGET);
  const upstream = new WebSocket(TARGET, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });

  // 缓存 upstream 未就绪时收到的客户端消息，连接后按序转发
  const pendingMessages = [];
  let upstreamReady = false;

  upstream.on('open', () => {
    console.log('[Proxy] Upstream connected');
    upstreamReady = true;

    // 转发缓存的消息
    if (pendingMessages.length > 0) {
      console.log(`[Proxy] Flushing ${pendingMessages.length} buffered message(s)`);
      for (const msg of pendingMessages) {
        upstream.send(msg);
      }
      pendingMessages.length = 0;
    }

    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'proxy.upstream_open' }));
    }
  });

  upstream.on('message', (data) => {
    const text = data.toString();
    // 只截断超长的 audio/image 数据，保留完整的控制消息和错误信息
    try {
      const ev = JSON.parse(text);
      if (ev.type === 'error' || ev.type?.endsWith('.created') || ev.type?.endsWith('.updated') || ev.type?.endsWith('.done')) {
        console.log('[Proxy] Upstream msg:', text);
      } else {
        console.log('[Proxy] Upstream msg:', text.substring(0, 500), text.length > 500 ? `... (${text.length} bytes)` : '');
      }
    } catch {
      console.log('[Proxy] Upstream msg (raw):', text.substring(0, 500));
    }
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: false });
    }
  });

  upstream.on('close', (code, reason) => {
    console.log('[Proxy] Upstream closed:', code, reason.toString());
    upstreamReady = false;
    if (client.readyState === WebSocket.OPEN) {
      client.close(code, reason.toString());
    }
  });

  upstream.on('error', (err) => {
    console.error('[Proxy] Upstream error:', err?.message || err);
    upstreamReady = false;
    try {
      client.send(JSON.stringify({ type: 'proxy.error', error: err?.message || 'upstream error' }));
    } catch {}
    client.close();
  });

  client.on('message', (data) => {
    const text = data.toString();
    try {
      const ev = JSON.parse(text);
      // 完整打印控制消息，截断 audio/image 数据
      if (ev.type === 'session.update' || ev.type === 'response.create') {
        console.log('[Proxy] Client msg:', text);
      } else {
        console.log('[Proxy] Client msg:', text.substring(0, 200), text.length > 200 ? `... (${text.length} bytes)` : '');
      }
    } catch {
      console.log('[Proxy] Client msg (raw):', text.substring(0, 200));
    }

    // 必须转为 string 发送 (text frame)，Qwen API 不接受 binary frame 的 JSON
    const strData = data.toString();
    if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
      upstream.send(strData);
    } else {
      console.log('[Proxy] Upstream not ready, buffering message');
      pendingMessages.push(strData);
    }
  });

  client.on('close', () => {
    try { upstream.close(); } catch {}
  });
});

console.log(`Qwen Realtime WS proxy listening on ws://localhost:${PORT}/realtime -> ${TARGET}`);
