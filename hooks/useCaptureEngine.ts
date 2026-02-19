/**
 * Capture Engine Hook
 * Responsibilities:
 * - Screen/Camera capture
 * - Periodic frame capture at FRAME_RATE
 * - Frame change detection
 * - Button detection via pixel analysis
 * - Output Frame + buttonResult, no AI communication
 */

import { useRef, useCallback, useState, RefObject } from 'react';
import { detectActionButtons, detectButtonTransition } from '../utils/buttonDetector';
import type { ButtonDetectionResult } from '../utils/buttonDetector';
import type { CaptureMode, Frame } from '../types/poker';

const FRAME_RATE = 1.0;
const JPEG_QUALITY = 0.85;
const MAX_IMAGE_DIMENSION = 1024;

interface UseCaptureEngineOptions {
  videoRef: RefObject<HTMLVideoElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  onFrame: (frame: Frame, buttonResult: ButtonDetectionResult, transition: ButtonTransition) => void;
  onStreamEnded?: () => void;
}

interface ButtonTransition {
  appeared: boolean;
  disappeared: boolean;
  current: boolean;
}

export function useCaptureEngine(opts: UseCaptureEngineOptions) {
  const { videoRef, canvasRef, onFrame, onStreamEnded } = opts;
  const frameIntervalRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastFrameRef = useRef<Frame | null>(null);
  const buttonResultRef = useRef<ButtonDetectionResult>({
    hasRedButton: false, hasBlueButton: false, redDensity: 0, confidence: 'LOW',
  });
  const prevButtonStateRef = useRef<boolean>(false);

  const [isRunning, setIsRunning] = useState(false);

  // Simple frame change detection: compare base64 string length + sampling
  const isFrameChanged = useCallback((newFrame: string, oldFrame: string | null): boolean => {
    if (!oldFrame) return true;
    const lenDiff = Math.abs(newFrame.length - oldFrame.length) / oldFrame.length;
    if (lenDiff > 0.12) return true;
    const step = 800;
    let diffCount = 0;
    let sampleCount = 0;
    for (let i = 0; i < Math.min(newFrame.length, oldFrame.length); i += step) {
      sampleCount++;
      if (newFrame[i] !== oldFrame[i]) diffCount++;
    }
    return sampleCount === 0 || (diffCount / sampleCount) > 0.25;
  }, []);

  // Capture single frame
  const captureFrame = useCallback((): Frame | null => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return null;

    const ctx = canvas.getContext('2d');
    if (!ctx || video.readyState !== 4) return null;

    const scale = Math.min(MAX_IMAGE_DIMENSION / video.videoWidth, MAX_IMAGE_DIMENSION / video.videoHeight);
    canvas.width = video.videoWidth * scale;
    canvas.height = video.videoHeight * scale;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const base64 = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    return { base64, canvas, timestamp: Date.now() };
  }, [videoRef, canvasRef]);

  const lastChangedTimeRef = useRef<number>(0);
  const IDLE_FORCE_SEND_MS = 15000;

  // Start media stream only (no capture loop)
  const start = useCallback(async (mode: CaptureMode) => {
    if (frameIntervalRef.current) {
      window.clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }

    let stream: MediaStream;
    if (mode === 'TAB') {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error('Screen capture not supported');
      }
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false
      });
    }

    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      try {
        await videoRef.current.play();
      } catch (e) {
        console.warn('video.play() interrupted:', e);
      }
      // Wait for video to be fully ready (readyState === 4)
      await new Promise<void>((resolve) => {
        const video = videoRef.current!;
        if (video.readyState >= 4) {
          resolve();
          return;
        }
        const onReady = () => {
          video.removeEventListener('canplaythrough', onReady);
          resolve();
        };
        video.addEventListener('canplaythrough', onReady);
        // Safety timeout: don't block forever
        setTimeout(() => {
          video.removeEventListener('canplaythrough', onReady);
          resolve();
        }, 3000);
      });
      console.log('[CaptureEngine] Video ready, readyState:', videoRef.current.readyState);
    }

    stream.getVideoTracks()[0].onended = () => {
      stop();
      onStreamEnded?.();
    };

    setIsRunning(true);
  }, [videoRef, onStreamEnded]);

  // Start the capture loop (call after WebSocket is connected)
  const startLoop = useCallback(() => {
    if (frameIntervalRef.current) {
      window.clearInterval(frameIntervalRef.current);
    }
    lastChangedTimeRef.current = Date.now();

    frameIntervalRef.current = window.setInterval(() => {
      const frame = captureFrame();
      if (!frame) return;

      // Detect buttons
      const btnResult = detectActionButtons(frame.canvas);
      buttonResultRef.current = btnResult;

      // Detect button transition
      const transition = detectButtonTransition(prevButtonStateRef.current, btnResult);
      prevButtonStateRef.current = transition.current;

      // Frame change detection
      const changed = isFrameChanged(frame.base64, lastFrameRef.current?.base64 ?? null);

      if (changed) {
        lastFrameRef.current = frame;
        lastChangedTimeRef.current = Date.now();
        onFrame(frame, btnResult, transition);
      } else {
        // 15s idle force-send (#10)
        const idleTime = Date.now() - lastChangedTimeRef.current;
        if (idleTime >= IDLE_FORCE_SEND_MS) {
          lastFrameRef.current = frame;
          lastChangedTimeRef.current = Date.now();
          onFrame(frame, btnResult, transition);
        }
      }
    }, 1000 / FRAME_RATE);
  }, [captureFrame, isFrameChanged, onFrame]);

  // Stop capture
  const stop = useCallback(() => {
    if (frameIntervalRef.current) {
      window.clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    lastFrameRef.current = null;
    buttonResultRef.current = { hasRedButton: false, hasBlueButton: false, redDensity: 0, confidence: 'LOW' };
    prevButtonStateRef.current = false;
    setIsRunning(false);
  }, [videoRef]);

  // Capture single frame on demand
  const captureOnce = useCallback((): Frame | null => {
    const frame = captureFrame();
    if (frame) {
      lastFrameRef.current = frame;
      return frame;
    }
    return null;
  }, [captureFrame]);

  return {
    isRunning,
    start,
    startLoop,
    stop,
    captureOnce,
    get lastFrame() { return lastFrameRef.current; },
    get buttonResult() { return buttonResultRef.current; },
  };
}
