/**
 * AI Dispatcher Hook
 * Responsibilities:
 * - Manage QwenRealtimeService lifecycle
 * - Connection/disconnection state
 * - Send scheduling (3s cooldown, force send, pending queue)
 * - Auto/Manual mode control
 * - Streaming response accumulation
 * - No business logic, just AI communication
 */

import { useRef, useCallback, useState } from 'react';
import { QwenRealtimeService } from '../services/qwenRealtime';
import { parsePokerResponse } from '../utils/parseResponse';
import type { ParsedResponse } from '../utils/parseResponse';
import { ConnectionState } from '../types/poker';
import type { DispatchMode, Frame } from '../types/poker';

interface UseAIDispatcherOptions {
  onResponse: (response: ParsedResponse) => void;
  onStreamDelta: (accumulatedText: string) => void;
  onStreamEnd: () => void;
  onError: (msg: string, isNetworkError: boolean) => void;
  onConnected?: () => void;
  onReadyForNextFrame?: () => void;
  shouldSuppressStreaming?: () => boolean;
}

export function useAIDispatcher(opts: UseAIDispatcherOptions) {
  const { onResponse, onStreamDelta, onStreamEnd, onError, onConnected, onReadyForNextFrame, shouldSuppressStreaming } = opts;

  const serviceRef = useRef<QwenRealtimeService | null>(null);
  const sendingRef = useRef(false);
  const lastSendTimeRef = useRef(0);
  const pendingFrameRef = useRef(false);
  const modeRef = useRef<DispatchMode>('MANUAL');

  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [isThinking, setIsThinking] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [mode, setModeState] = useState<DispatchMode>('MANUAL');

  // Stream accumulation for early action detection
  const streamAccRef = useRef('');

  const connect = useCallback(async () => {
    setConnectionState(ConnectionState.CONNECTING);
    if (!serviceRef.current) {
      serviceRef.current = new QwenRealtimeService({
        onStateChange: (state) => {
          setConnectionState(state);
          if (state === ConnectionState.CONNECTED) {
            onConnected?.();
          }
        },
        onTranscription: (text) => {
          const parsed = parsePokerResponse(text);
          onResponse(parsed);
          streamAccRef.current = '';
        },
        onDelta: (delta) => {
          streamAccRef.current += delta;
          // Only update streaming text if not suppressed (#4)
          if (!shouldSuppressStreaming?.()) {
            setStreamingText((prev) => prev + delta);
          }
          onStreamDelta(streamAccRef.current);
        },
        onResponseDone: () => {
          sendingRef.current = false;
          setIsThinking(false);
          onStreamEnd();
          // Auto-resend pending frame (#2)
          if (pendingFrameRef.current && modeRef.current === 'AUTO') {
            pendingFrameRef.current = false;
            onReadyForNextFrame?.();
          }
        },
        onError: (msg, isNetwork) => {
          sendingRef.current = false;
          setIsThinking(false);
          if (isNetwork) {
            setConnectionState(ConnectionState.ERROR);
          }
          onError(msg, isNetwork ?? false);
        },
      });
    }
    await serviceRef.current.connect();
  }, [onResponse, onStreamDelta, onStreamEnd, onError, onConnected, onReadyForNextFrame, shouldSuppressStreaming]);

  const disconnect = useCallback(() => {
    serviceRef.current?.disconnect();
    sendingRef.current = false;
    pendingFrameRef.current = false;
    setIsThinking(false);
    setStreamingText('');
    streamAccRef.current = '';
  }, []);

  const sendFrame = useCallback((frame: Frame, force = false) => {
    if (!serviceRef.current || sendingRef.current) {
      if (force) pendingFrameRef.current = true;
      return;
    }

    // Manual mode skips auto-send (unless forced)
    if (modeRef.current === 'MANUAL' && !force) return;

    // Min 3s cooldown (skip if forced)
    if (!force && lastSendTimeRef.current > 0) {
      const sinceLastSend = Date.now() - lastSendTimeRef.current;
      if (sinceLastSend < 3000) return;
    }

    sendingRef.current = true;
    lastSendTimeRef.current = Date.now();
    pendingFrameRef.current = false;

    // Reset stream state
    streamAccRef.current = '';
    setStreamingText('');

    // Show thinking if not already showing action
    setIsThinking(true);

    serviceRef.current.sendFrame(frame.base64);
  }, []);

  const setMode = useCallback((newMode: DispatchMode) => {
    modeRef.current = newMode;
    setModeState(newMode);
  }, []);

  return {
    connectionState,
    isThinking,
    streamingText,
    mode,
    connect,
    disconnect,
    sendFrame,
    setMode,
    get pendingFrame() { return pendingFrameRef.current; },
    get streamAccumulated() { return streamAccRef.current; },
  };
}
