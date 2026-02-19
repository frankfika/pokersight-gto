/**
 * Shared types for Poker GTO application
 */

import { detectActionButtons, detectButtonTransition } from '../utils/buttonDetector';
import type { ButtonDetectionResult } from '../utils/buttonDetector';
import { parsePokerResponse } from '../utils/parseResponse';
import type { AnalysisData, AdviceType, ParsedResponse } from '../utils/parseResponse';
import { ConnectionState } from '../types';

export type { AdviceType, AnalysisData, ParsedResponse, ButtonDetectionResult };
export { ConnectionState, parsePokerResponse, detectActionButtons, detectButtonTransition };

export type CaptureMode = 'TAB' | 'CAMERA';

export type DispatchMode = 'AUTO' | 'MANUAL';

export type UIState =
  | { phase: 'WAITING'; display: string; analysis: AnalysisData | null }
  | { phase: 'ACTION' | 'FOLD' | 'GOOD' | 'READY'; display: string; analysis: AnalysisData };

export interface Frame {
  base64: string;
  canvas: HTMLCanvasElement;
  timestamp: number;
}

export interface CaptureEngine {
  isRunning: boolean;
  start: (mode: CaptureMode) => Promise<void>;
  startLoop: () => void;
  stop: () => void;
  captureOnce: () => Frame | null;
  lastFrame: Frame | null;
  buttonResult: ButtonDetectionResult;
}

export interface AIDispatcher {
  connectionState: ConnectionState;
  isThinking: boolean;
  streamingText: string;
  mode: DispatchMode;
  connect: () => Promise<void>;
  disconnect: () => void;
  sendFrame: (frame: Frame, force?: boolean) => void;
  setMode: (mode: DispatchMode) => void;
  pendingFrame: boolean;
}

export interface AnalysisFSM {
  state: UIState;
  pinnedAnalysis: AnalysisData | null;
  handleResponse: (response: ParsedResponse, buttonResult: ButtonDetectionResult) => void;
  handleStreamDelta: (accumulatedText: string, buttonResult: ButtonDetectionResult) => void;
  handleButtonAppeared: () => void;
  handleButtonsDetectedWhileWaiting: () => void;
  reset: () => void;
}
