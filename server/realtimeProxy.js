import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const PORT = process.env.WS_PROXY_PORT ? Number(process.env.WS_PROXY_PORT) : 3301;
const MODEL = process.env.QWEN_REALTIME_MODEL || 'qwen3-omni-flash-realtime';
const VISION_MODEL = process.env.QWEN_VISION_MODEL || 'qwen-vl-max';
const REGION = process.env.DASHSCOPE_REGION || 'cn';

const WS_BASE = REGION === 'intl' ? 'wss://dashscope-intl.aliyuncs.com' : 'wss://dashscope.aliyuncs.com';
const WS_TARGET = `${WS_BASE}/api-ws/v1/realtime?model=${encodeURIComponent(MODEL)}`;

const HTTP_BASE = REGION === 'intl'
  ? 'https://dashscope-intl.aliyuncs.com'
  : 'https://dashscope.aliyuncs.com';

const API_KEY = process.env.DASHSCOPE_API_KEY;

if (!API_KEY) {
  console.error('Missing DASHSCOPE_API_KEY');
  process.exit(1);
}

// ── HTTP Server (fallback /api/analyze endpoint) ──────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/analyze') {
    let body = '';
    for await (const chunk of req) body += chunk;

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const { image, systemPrompt } = parsed;
    if (!image) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing image field' }));
      return;
    }

    const apiUrl = `${HTTP_BASE}/compatible-mode/v1/chat/completions`;
    const payload = {
      model: VISION_MODEL,
      stream: true,
      max_tokens: 100,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${image}` },
            },
            { type: 'text', text: '分析这张扑克桌画面，判断当前状态并给出建议。' },
          ],
        },
      ],
    };

    console.log(`[Proxy] POST /api/analyze → ${VISION_MODEL} (image ${Math.round(image.length / 1024)}KB)`);

    let fullResponseLog = '';
    try {
      const upstream = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(payload),
      });

      if (!upstream.ok) {
        const errText = await upstream.text();
        console.error(`[Proxy] DashScope error ${upstream.status}:`, errText);
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `DashScope API error: ${upstream.status}`, detail: errText }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);

        buffer += chunk;
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data && data !== '[DONE]') {
              try {
                const parsed = JSON.parse(data);
                const content = parsed.choices?.[0]?.delta?.content;
                if (content) fullResponseLog += content;
              } catch {}
            }
          }
        }
      }

      res.end();
      console.log('[Proxy] Response:', fullResponseLog || '(empty)');
    } catch (err) {
      console.error('[Proxy] Fetch error:', err?.message || err);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upstream fetch failed', detail: err?.message }));
      } else {
        res.end();
      }
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ── WebSocket Proxy (/realtime) ──────────────────────────────────
const wss = new WebSocketServer({ server, path: '/realtime' });

wss.on('connection', (client) => {
  console.log('[Proxy] Client connected, connecting upstream to', WS_TARGET);
  const upstream = new WebSocket(WS_TARGET, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });

  const pendingMessages = [];
  let upstreamReady = false;
  let pingInterval = null;

  upstream.on('open', () => {
    console.log('[Proxy] Upstream connected');
    upstreamReady = true;

    // 心跳保活：每 20 秒发一次 ping，防止空闲超时断开
    pingInterval = setInterval(() => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.ping();
      }
    }, 20000);

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
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (client.readyState === WebSocket.OPEN) {
      client.close(code, reason.toString());
    }
  });

  upstream.on('error', (err) => {
    console.error('[Proxy] Upstream error:', err?.message || err);
    upstreamReady = false;
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    try {
      client.send(JSON.stringify({ type: 'proxy.error', error: err?.message || 'upstream error' }));
    } catch {}
    client.close();
  });

  client.on('message', (data) => {
    const text = data.toString();
    try {
      const ev = JSON.parse(text);
      if (ev.type === 'session.update' || ev.type === 'response.create') {
        console.log('[Proxy] Client msg:', text);
      } else {
        console.log('[Proxy] Client msg:', text.substring(0, 200), text.length > 200 ? `... (${text.length} bytes)` : '');
      }
    } catch {
      console.log('[Proxy] Client msg (raw):', text.substring(0, 200));
    }

    const strData = data.toString();
    if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
      upstream.send(strData);
    } else {
      console.log('[Proxy] Upstream not ready, buffering message');
      pendingMessages.push(strData);
    }
  });

  client.on('close', () => {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    try { upstream.close(); } catch {}
  });
});

server.listen(PORT, () => {
  console.log(`Qwen proxy listening on http://localhost:${PORT}`);
  console.log(`  WS  /realtime      → DashScope Realtime (${MODEL})`);
  console.log(`  POST /api/analyze  → DashScope Vision (${VISION_MODEL})`);
});
