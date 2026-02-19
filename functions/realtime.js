// Cloudflare Pages Function — WebSocket proxy for DashScope Realtime API
// Path: /realtime
// Approach: modify request URL + inject Authorization, return fetch() directly.
// Cloudflare handles the WebSocket upgrade automatically.

export async function onRequest(context) {
  const { request, env } = context;

  const apiKey = env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'DASHSCOPE_API_KEY not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const model = env.QWEN_REALTIME_MODEL || 'qwen3-omni-flash-realtime';
  const upstreamUrl = `https://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(model)}`;

  // Clone headers, inject Authorization
  const headers = new Headers(request.headers);
  headers.set('Authorization', `Bearer ${apiKey}`);

  // Forward the request (including WebSocket Upgrade) to upstream
  const upstreamReq = new Request(upstreamUrl, {
    method: request.method,
    headers,
    body: request.body,
  });

  return fetch(upstreamReq);
}
