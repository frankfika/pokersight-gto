/**
 * Analysis FSM (Finite State Machine) Hook
 * Responsibilities:
 * - Anti-flicker / anti-misjudgment logic (bi-directional confirmation)
 * - Pixel correction (AI says WAITING but buttons still visible)
 * - Deduplication (skip same state)
 * - Confirmation counters (waitingConfirmCount / actionConfirmCount)
 * - Only outputs final UIState, no AI or capture communication
 */

import { useRef, useCallback, useState } from 'react';
import { parsePokerResponse } from '../utils/parseResponse';
import type { ParsedResponse, AdviceType, AnalysisData } from '../utils/parseResponse';
import type { ButtonDetectionResult } from '../utils/buttonDetector';

export type UIState =
  | { phase: 'WAITING'; display: string; analysis: AnalysisData | null }
  | { phase: 'ACTION' | 'FOLD' | 'GOOD' | 'READY'; display: string; analysis: AnalysisData };

interface UseAnalysisFSMOptions {
  onStateChange?: (state: UIState) => void;
}

export function useAnalysisFSM(opts: UseAnalysisFSMOptions = {}) {
  const { onStateChange } = opts;

  // Current state
  const [state, setState] = useState<UIState>({ phase: 'WAITING', display: '等待中...', analysis: null });
  const [pinnedAnalysis, setPinnedAnalysis] = useState<AnalysisData | null>(null);

  // Refs for synchronous access within callbacks
  const stateRef = useRef<UIState>(state);
  const pinnedAnalysisRef = useRef<AnalysisData | null>(null);

  // Confirmation counters
  const waitingConfirmCountRef = useRef(0);
  const actionConfirmCountRef = useRef(0);

  // Debounce timers
  const lastActionSetTimeRef = useRef(0);

  // Deduplication
  const lastStateRef = useRef<{ type: AdviceType; display: string } | null>(null);

  // Early action detection
  const earlyActionDetectedRef = useRef(false);

  // Pixel deadlock escape: consecutive AI WAITING count despite red button detection
  const consecutivePixelRejectCountRef = useRef(0);
  const PIXEL_REJECT_ESCAPE_THRESHOLD = 5;

  const updateState = useCallback((newState: UIState) => {
    stateRef.current = newState;
    setState(newState);
    onStateChange?.(newState);
  }, [onStateChange]);

  const isWaitingPhase = useCallback((phase: string) => phase === 'WAITING', []);
  const isActionPhase = useCallback((phase: string) => ['ACTION', 'FOLD', 'GOOD', 'READY'].includes(phase), []);

  const handleResponse = useCallback((response: ParsedResponse, buttonResult: ButtonDetectionResult) => {
    // Reset early action detection for each new response
    earlyActionDetectedRef.current = false;

    // SKIP = non-poker screen, skip UI update
    if (response.type === 'SKIP') return;

    const waiting = response.type === 'NEUTRAL' || response.type === 'READY';
    const currentPhase = stateRef.current.phase;

    // ── Anti-flicker / Anti-misjudgment: Bi-directional confirmation ──
    if (waiting) {
      waitingConfirmCountRef.current++;
      actionConfirmCountRef.current = 0;
    } else {
      actionConfirmCountRef.current++;
      waitingConfirmCountRef.current = 0;
    }

    // Anti-flicker: Currently showing ACTION, AI says WAITING
    // Rules: No pixel buttons → accept immediately (consistent)
    //        Pixel buttons + ACTION<3s → need 2 confirmations
    //        ACTION>3s → accept immediately
    const currentlyShowingAction = isActionPhase(currentPhase);
    if (waiting && currentlyShowingAction) {
      const actionAge = Date.now() - lastActionSetTimeRef.current;
      const buttonsStillVisible = buttonResult.hasRedButton;
      if (buttonsStillVisible && actionAge < 3000 && waitingConfirmCountRef.current < 2) {
        console.log(`⏸ Anti-flicker: WAITING #${waitingConfirmCountRef.current}/2, buttons visible, ACTION set ${actionAge}ms ago`);
        if (response.type === 'READY' && response.analysis) {
          pinnedAnalysisRef.current = response.analysis;
          setPinnedAnalysis(response.analysis);
        }
        return;
      }
      console.log(`✅ WAITING confirmed (ACTION lasted ${actionAge}ms, buttons=${buttonsStillVisible}, count=${waitingConfirmCountRef.current})`);
    }

    // Pixel correction: AI says WAITING but pixel detected red button → AI vision error, reject
    // Deadlock escape: if AI consistently says WAITING (>=5 times), trust AI over pixel detector
    if (waiting && buttonResult.hasRedButton) {
      consecutivePixelRejectCountRef.current++;
      if (consecutivePixelRejectCountRef.current >= PIXEL_REJECT_ESCAPE_THRESHOLD) {
        console.log(`🔓 Pixel deadlock escape: AI said WAITING ${consecutivePixelRejectCountRef.current} times despite red button, trusting AI`);
        consecutivePixelRejectCountRef.current = 0;
        // Fall through — accept the WAITING
      } else {
        console.log(`⚠️ AI says WAITING but red button detected (confidence=${buttonResult.confidence}, count=${consecutivePixelRejectCountRef.current}/${PIXEL_REJECT_ESCAPE_THRESHOLD}), rejecting`);
        if (response.analysis) {
          pinnedAnalysisRef.current = response.analysis;
          setPinnedAnalysis(response.analysis);
        }
        return;
      }
    } else {
      // Reset counter when not in pixel-reject scenario
      consecutivePixelRejectCountRef.current = 0;
    }

    // Anti-misjudgment: Currently WAITING, AI says ACTION → decide confirmation based on pixel confidence
    // HIGH (red+blue) = 1, MEDIUM (red) = 1, LOW (no buttons) = 2
    const currentlyWaiting = currentPhase === 'WAITING';
    if (!waiting && currentlyWaiting) {
      const confidence = buttonResult.confidence;
      const requiredConfirms = confidence === 'HIGH' ? 1 : confidence === 'MEDIUM' ? 1 : 2;
      if (actionConfirmCountRef.current < requiredConfirms) {
        console.log(`⏸ Anti-misjudgment: ACTION #${actionConfirmCountRef.current}/${requiredConfirms} (confidence=${confidence}), skipping`);
        return;
      }
      console.log(`✅ ACTION confirmed (confidence=${confidence}, count=${actionConfirmCountRef.current})`);
    }

    // Deduplication: avoid same state triggering UI update (but always update analysis)
    const lastState = lastStateRef.current;
    let isDuplicate = false;
    if (lastState) {
      const wasWaiting = lastState.type === 'NEUTRAL' || lastState.type === 'READY';
      const isNowWaiting = waiting;
      if (wasWaiting && isNowWaiting) {
        isDuplicate = true;
      } else if (lastState.type === response.type && lastState.display === response.display) {
        isDuplicate = true;
      }
    }

    // Always update analysis data (hand/pot may have changed)
    if (response.analysis) {
      if (waiting) {
        pinnedAnalysisRef.current = response.analysis;
        setPinnedAnalysis(response.analysis);
      } else {
        pinnedAnalysisRef.current = response.analysis;
        setPinnedAnalysis(response.analysis);
      }
    }

    if (isDuplicate) {
      console.log('⏭ Same action, analysis updated only');
      return;
    }

    lastStateRef.current = { type: response.type, display: response.display };
    console.log('✅ State changed:', response.type, '→', response.display);

    if (waiting) {
      // Not my turn: force switch to WAITING, clear old action display
      const newState: UIState = { phase: 'WAITING', display: '等待中...', analysis: pinnedAnalysisRef.current };
      updateState(newState);
    } else {
      // My turn (ACTION/FOLD/GOOD) — trust AI, display immediately
      lastActionSetTimeRef.current = Date.now();
      const phase = response.type as 'ACTION' | 'FOLD' | 'GOOD' | 'READY';
      const newState: UIState = { phase, display: response.display, analysis: pinnedAnalysisRef.current ?? response.analysis! };
      updateState(newState);
    }
  }, [isActionPhase, isWaitingPhase, updateState]);

  const handleStreamDelta = useCallback((accumulatedText: string, buttonResult: ButtonDetectionResult) => {
    // Early action detection from streaming text
    if (!earlyActionDetectedRef.current) {
      const m = accumulatedText.match(/ACTION[:：]\s*(CHECK|FOLD|CALL|RAISE|ALLIN|BET|WAITING|SKIP)/i);
      if (m) {
        // Parse accumulated text
        const earlyResult = parsePokerResponse(accumulatedText);
        if (earlyResult.type !== 'SKIP') {
          const w = earlyResult.type === 'NEUTRAL' || earlyResult.type === 'READY';
          if (w) {
            // WAITING case — safe to display immediately (no contradiction risk)
            earlyActionDetectedRef.current = true;
            waitingConfirmCountRef.current++;
            const showingAction = isActionPhase(stateRef.current.phase);
            const buttonsStillVisible = buttonResult.hasRedButton;
            const actionAge = Date.now() - lastActionSetTimeRef.current;
            if (showingAction && buttonsStillVisible && actionAge < 3000 && waitingConfirmCountRef.current < 2) {
              // Skip for now
            } else {
              updateState({ phase: 'WAITING', display: '等待中...', analysis: pinnedAnalysisRef.current });
            }
          } else {
            // ACTION case — wait for 分析: field before displaying to avoid flash of wrong action
            const hasAnalysis = /分析[:：]/i.test(accumulatedText);
            if (!hasAnalysis) {
              // 分析 not yet received, defer display
              return;
            }
            earlyActionDetectedRef.current = true;
            // Re-parse with complete analysis text
            const fullResult = parsePokerResponse(accumulatedText);
            if (fullResult.type === 'SKIP' || fullResult.type === 'NEUTRAL' || fullResult.type === 'READY') return;
            actionConfirmCountRef.current++;
            waitingConfirmCountRef.current = 0;
            const confidence = buttonResult.confidence;
            const requiredConfirms = confidence === 'HIGH' ? 1 : confidence === 'MEDIUM' ? 1 : 2;
            if (stateRef.current.phase === 'WAITING' && actionConfirmCountRef.current < requiredConfirms) {
              // Skip for now
            } else {
              const phase = fullResult.type as 'ACTION' | 'FOLD' | 'GOOD' | 'READY';
              updateState({ phase, display: fullResult.display, analysis: pinnedAnalysisRef.current ?? fullResult.analysis! });
            }
          }
        }
      }
    }
  }, [isActionPhase, updateState]);

  // Pre-increment actionConfirmCount when buttons appear (#8)
  const handleButtonAppeared = useCallback(() => {
    actionConfirmCountRef.current = Math.max(actionConfirmCountRef.current, 1);
  }, []);

  // Show READY if buttons detected while WAITING and we have cached analysis (#9)
  const handleButtonsDetectedWhileWaiting = useCallback(() => {
    if (stateRef.current.phase === 'WAITING' && pinnedAnalysisRef.current) {
      updateState({ phase: 'READY', display: '就绪', analysis: pinnedAnalysisRef.current });
    }
  }, [updateState]);

  const reset = useCallback(() => {
    waitingConfirmCountRef.current = 0;
    actionConfirmCountRef.current = 0;
    lastActionSetTimeRef.current = 0;
    lastStateRef.current = null;
    earlyActionDetectedRef.current = false;
    consecutivePixelRejectCountRef.current = 0;
    pinnedAnalysisRef.current = null;
    setPinnedAnalysis(null);
    updateState({ phase: 'WAITING', display: '等待中...', analysis: null });
  }, [updateState]);

  return {
    state,
    pinnedAnalysis,
    handleResponse,
    handleStreamDelta,
    handleButtonAppeared,
    handleButtonsDetectedWhileWaiting,
    reset,
  };
}
