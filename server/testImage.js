/**
 * 测试 Qwen Realtime API 图片发送格式
 */
import WebSocket from 'ws';
import { createCanvas } from 'canvas';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const API_KEY = process.env.DASHSCOPE_API_KEY;
const TARGET = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-omni-flash-realtime';

// 生成测试 JPEG
const canvas = createCanvas(100, 100);
const ctx = canvas.getContext('2d');
ctx.fillStyle = 'red';
ctx.fillRect(0, 0, 100, 100);
const jpegBuf = canvas.toBuffer('image/jpeg', { quality: 0.8 });
const imageB64 = jpegBuf.toString('base64');
console.log('Image base64 length:', imageB64.length);

const tests = [
  {
    name: 'Test 1: data URI format',
    sendImage(ws) {
      const silent = Buffer.alloc(3200).toString('base64');
      ws.send(JSON.stringify({ event_id: 'e2', type: 'input_audio_buffer.append', audio: silent }));
      ws.send(JSON.stringify({ event_id: 'e3', type: 'input_image_buffer.append', image: 'data:image/jpeg;base64,' + imageB64 }));
      ws.send(JSON.stringify({ event_id: 'e4', type: 'input_audio_buffer.commit' }));
      ws.send(JSON.stringify({ event_id: 'e5', type: 'response.create' }));
    },
  },
  {
    name: 'Test 2: conversation.item.create with image_url',
    sendImage(ws) {
      ws.send(JSON.stringify({
        event_id: 'e2',
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_audio', audio: Buffer.alloc(3200).toString('base64') },
            { type: 'input_image', image_url: { url: 'data:image/jpeg;base64,' + imageB64 } },
          ],
        },
      }));
      ws.send(JSON.stringify({ event_id: 'e5', type: 'response.create' }));
    },
  },
  {
    name: 'Test 3: conversation.item.create text + image_url',
    sendImage(ws) {
      ws.send(JSON.stringify({
        event_id: 'e2',
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '描述这张图片' },
            { type: 'input_image', image_url: { url: 'data:image/jpeg;base64,' + imageB64 } },
          ],
        },
      }));
      ws.send(JSON.stringify({ event_id: 'e5', type: 'response.create' }));
    },
  },
  {
    name: 'Test 4: audio-only (no image) as control',
    sendImage(ws) {
      const silent = Buffer.alloc(3200).toString('base64');
      ws.send(JSON.stringify({ event_id: 'e2', type: 'input_audio_buffer.append', audio: silent }));
      ws.send(JSON.stringify({ event_id: 'e4', type: 'input_audio_buffer.commit' }));
      ws.send(JSON.stringify({ event_id: 'e5', type: 'response.create' }));
    },
  },
];

let idx = 0;
function runTest() {
  if (idx >= tests.length) {
    console.log('\n=== All tests done ===');
    process.exit(0);
    return;
  }
  const test = tests[idx++];
  console.log(`\n${'='.repeat(50)}`);
  console.log(test.name);
  console.log('='.repeat(50));

  const ws = new WebSocket(TARGET, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  let done = false;

  ws.on('message', (data) => {
    const ev = JSON.parse(data.toString());
    const skip = ['response.audio.delta', 'response.audio_transcript.delta', 'response.audio.done', 'response.audio_transcript.done', 'output_audio_buffer.started', 'output_audio_buffer.done', 'output_audio_buffer.cleared'];
    if (!skip.includes(ev.type)) {
      const extra = ev.error ? ' ' + JSON.stringify(ev.error) : '';
      const delta = ev.delta ? ' "' + ev.delta.substring(0, 100) + '"' : '';
      console.log(`  [${test.name}] ${ev.type}${extra}${delta}`);
    }

    if (ev.type === 'session.created') {
      ws.send(JSON.stringify({
        event_id: 'e1',
        type: 'session.update',
        session: { modalities: ['text', 'audio'], instructions: '描述你看到的内容' },
      }));
    }

    if (ev.type === 'session.updated') {
      test.sendImage(ws);
    }

    if (ev.type === 'response.done' && !done) {
      done = true;
      console.log(`  ✅ ${test.name}: response completed`);
      ws.close();
    }
  });

  ws.on('close', (code, reason) => {
    const r = reason.toString();
    if (!done) {
      console.log(`  ❌ ${test.name}: closed ${code} ${r}`);
    }
    setTimeout(runTest, 1500);
  });
  ws.on('error', (e) => console.error(`  [${test.name}] ERROR:`, e.message));
  setTimeout(() => { if (!done) { ws.close(); } }, 15000);
}

runTest();
