declare const process: any;

const WS_PROXY_URL: string = (process.env as any).VITE_WS_PROXY_URL || '';
const WS_PROXY_PORT: string = (process.env as any).WS_PROXY_PORT || '3301';

function isProduction(): boolean {
  return typeof window !== 'undefined'
    && window.location.hostname !== 'localhost'
    && window.location.hostname !== '127.0.0.1';
}

/**
 * WebSocket URL for realtime proxy.
 * Priority:
 * 1. VITE_WS_PROXY_URL env var (explicit external proxy)
 * 2. Production auto-detect → same-origin wss://host/realtime
 * 3. localhost fallback → ws://localhost:3301/realtime
 */
export function getRealtimeWsUrl(): string {
  if (WS_PROXY_URL) {
    const base = WS_PROXY_URL.replace(/\/+$/, '');
    return `${base}/realtime`;
  }
  if (isProduction()) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/realtime`;
  }
  return `ws://localhost:${WS_PROXY_PORT}/realtime`;
}

/**
 * HTTP URL for analyze API.
 * Priority:
 * 1. VITE_WS_PROXY_URL env var → derive http(s) from ws(s)
 * 2. Production auto-detect → same-origin /api/analyze
 * 3. localhost fallback → http://localhost:3301/api/analyze
 */
export function getAnalyzeHttpUrl(): string {
  if (WS_PROXY_URL) {
    const base = WS_PROXY_URL.replace(/\/+$/, '');
    const httpBase = base.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    return `${httpBase}/api/analyze`;
  }
  if (isProduction()) {
    return `${window.location.origin}/api/analyze`;
  }
  return `http://localhost:${WS_PROXY_PORT}/api/analyze`;
}
