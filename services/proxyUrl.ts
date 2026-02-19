declare const process: any;

const WS_PROXY_URL: string = (process.env as any).VITE_WS_PROXY_URL || '';
const WS_PROXY_PORT: string = (process.env as any).WS_PROXY_PORT || '3301';

/**
 * WebSocket URL for realtime proxy.
 * - If VITE_WS_PROXY_URL is set (production): wss://proxy.example.com/realtime
 * - Otherwise (local dev): ws://localhost:3301/realtime
 */
export function getRealtimeWsUrl(): string {
  if (WS_PROXY_URL) {
    const base = WS_PROXY_URL.replace(/\/+$/, '');
    return `${base}/realtime`;
  }
  return `ws://localhost:${WS_PROXY_PORT}/realtime`;
}

/**
 * HTTP URL for analyze API.
 * - If VITE_WS_PROXY_URL is set (production): derive http(s) from ws(s) URL
 * - Otherwise (local dev): http://localhost:3301/api/analyze
 */
export function getAnalyzeHttpUrl(): string {
  if (WS_PROXY_URL) {
    const base = WS_PROXY_URL.replace(/\/+$/, '');
    const httpBase = base.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    return `${httpBase}/api/analyze`;
  }
  return `http://localhost:${WS_PROXY_PORT}/api/analyze`;
}
