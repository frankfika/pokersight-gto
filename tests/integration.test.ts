
import { describe, it, expect, vi } from 'vitest';
import { WebSocket } from 'ws';

describe('Realtime Proxy Integration Test', () => {
  // 注意：需要确保 `npm run ws-proxy` 已经在后台运行
  const PROXY_URL = 'ws://localhost:3301/realtime';

  it('should connect to local proxy and receive session.created', async () => {
    // 设置超时，防止无限等待
    const timeout = 5000;
    
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(PROXY_URL);
      
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Connection timeout'));
      }, timeout);

      ws.on('open', () => {
        console.log('Connected to proxy');
        // 发送初始化配置，模拟前端行为
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text'],
            instructions: 'You are a poker assistant.'
          }
        }));
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        console.log('Received:', msg.type);

        if (msg.type === 'session.created' || msg.type === 'session.updated') {
          clearTimeout(timer);
          ws.close();
          resolve(); // 只要收到 session 相关消息就算成功
        }
        
        if (msg.type === 'error') {
          clearTimeout(timer);
          ws.close();
          reject(new Error(`Proxy returned error: ${msg.error.message}`));
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }, 10000);
});
