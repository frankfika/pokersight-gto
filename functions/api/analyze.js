// Cloudflare Pages Function — HTTP SSE proxy for DashScope Vision API
// Path: POST /api/analyze

export async function onRequestPost(context) {
  const { request, env } = context;

  const apiKey = env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'DASHSCOPE_API_KEY not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let parsed;
  try {
    parsed = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { image, systemPrompt } = parsed;
  if (!image) {
    return new Response(JSON.stringify({ error: 'Missing image field' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const visionModel = env.QWEN_VISION_MODEL || 'qwen-vl-max';
  const apiUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

  const payload = {
    model: visionModel,
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

  try {
    const upstream = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      return new Response(JSON.stringify({ error: `DashScope API error: ${upstream.status}`, detail: errText }), {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Stream upstream body directly to client (no buffering)
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Upstream fetch failed', detail: err?.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// Handle CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
