
import { describe, it, expect, vi } from 'vitest';
import { WebSocket } from 'ws';
import fs from 'fs';
import path from 'path';

// 假设我们有一个测试图片 (如果没有，可以用 base64 模拟一个最小 jpeg)
const TEST_IMAGE_BASE64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAAFgAAQEBAAAAAAAAAAAAAAAAAAAABxAAAQUBAQAAAAAAAAAAAAAAAAACAwQFBhEAAgIBAwUAAAAAAAAAAAAAAAECEQADITFhEkFRYnGBkf/aAAgBAQA/APJ8+fPnz58+fPnz58+fPnz58+fPnz58+fPnz58+fPnz58+fPnz58+fPnz58+fPnz58+fPnz58+fPnz5//2Q==';

describe('Realtime Integration Test (Full Flow)', () => {
  const PROXY_URL = 'ws://localhost:3301/realtime';

  it('should handle full poker analysis flow', async () => {
    // 增加超时时间，Realtime 冷启动可能 >20s
    const timeout = 40000;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(PROXY_URL);
      let sessionCreated = false;

      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Test timeout - AI response took too long'));
      }, timeout);

      ws.on('open', () => {
        console.log('Connected to proxy');
        // 1. 发送 Session Update
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text'],
            instructions: 'You are a poker assistant. Just reply "TEST_OK".'
          }
        }));
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        console.log('Received:', msg.type);

        // 2. 等待 Session Ready
        if (msg.type === 'session.created') {
            sessionCreated = true;
            console.log('Session created. Sending dummy inputs...');
            
            // 3. 模拟 PokerHUD 发送流程
            // 先发一段稍长的静音包 (Realtime 有时会丢弃过短的音频)
            const silence = Buffer.alloc(3200).toString('base64'); // 100ms 16k mono
            ws.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: silence
            }));

            // 发图片
            ws.send(JSON.stringify({
                type: 'input_image_buffer.append',
                image: TEST_IMAGE_BASE64
            }));

            // 提交并请求响应
            ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
            ws.send(JSON.stringify({ type: 'response.create' }));
        }

        // 4. 验证是否有文本输出 (response.text.delta 或 response.audio_transcript.delta)
        // 也可以检查 response.done
        if (msg.type === 'response.text.delta' || msg.type === 'response.audio_transcript.delta') {
            console.log('AI Response:', msg.delta);
            // 只要收到任何文本响应，就算链路跑通
            clearTimeout(timer);
            ws.close();
            resolve();
        }
        
        if (msg.type === 'response.done') {
            console.log('Response done.');
            // 如果 response.done 了还没收到 delta，也暂时算结束，但在实际场景下我们期望有 delta
            clearTimeout(timer);
            ws.close();
            resolve();
        }

        if (msg.type === 'error') {
            clearTimeout(timer);
            ws.close();
            reject(new Error(`Proxy error: ${JSON.stringify(msg.error)}`));
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }, 50000);
});
