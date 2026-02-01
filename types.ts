export enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  RECONNECTING = 'RECONNECTING',
  ERROR = 'ERROR',
}

export interface SessionStatus {
  /** Seconds remaining before auto-reconnect */
  remainingSeconds: number;
  /** Total reconnect count in this session */
  reconnectCount: number;
}

export interface PokerAdvice {
  action: 'FOLD' | 'CHECK' | 'CALL' | 'RAISE' | 'ALL-IN' | 'WAITING';
  amount?: string;
  reasoning?: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface AudioDeviceConfig {
  sampleRate: number;
  channelCount: number;
}
