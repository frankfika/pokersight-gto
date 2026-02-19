import { useRef, useState, useCallback, useEffect } from 'react';
import { useCaptureEngine } from '../hooks/useCaptureEngine';
import { useAIDispatcher } from '../hooks/useAIDispatcher';
import { useAnalysisFSM } from '../hooks/useAnalysisFSM';
import { ConnectionState, detectActionButtons } from '../types/poker';
import type { Frame, DispatchMode } from '../types/poker';

const FRAME_RATE = 1.0;
const MAX_IMAGE_DIMENSION = 1024;

type CaptureMode = 'TAB' | 'CAMERA';

const isMacOS = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|Macintosh/i.test(navigator.userAgent);

const PokerHUD = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef<DispatchMode>('MANUAL');
  const sendFrameRef = useRef<((frame: Frame, force?: boolean) => void) | null>(null);
  const startLoopRef = useRef<(() => void) | null>(null);
  const captureOnceRef = useRef<(() => Frame | null) | null>(null);

  const [captureMode, setCaptureMode] = useState<CaptureMode>('TAB');
  const [debugImage, setDebugImage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [isActive, setIsActive] = useState(false);
  const [showPreview, setShowPreview] = useState(true);

  // Ref to track uiState synchronously for shouldSuppressStreaming
  const uiStateRef = useRef<{ phase: string }>({ phase: 'WAITING' });

  // Analysis FSM handles anti-flicker, state transitions
  const {
    state: uiState,
    pinnedAnalysis,
    handleResponse,
    handleStreamDelta,
    handleButtonAppeared,
    handleButtonsDetectedWhileWaiting,
    reset: resetFSM,
  } = useAnalysisFSM();

  // Keep uiStateRef in sync
  useEffect(() => {
    uiStateRef.current = uiState;
  }, [uiState]);

  // Handle button disappear event
  const handleButtonDisappear = useCallback(() => {
    console.log('🔴 Buttons disappeared → user acted, clearing advice');
    resetFSM();
  }, [resetFSM]);

  // Handle AI response - defined early for useAIDispatcher
  const handleAIResponse = useCallback((response: any) => {
    const btnResult = detectActionButtons(canvasRef.current!);
    handleResponse(response, btnResult);
  }, [handleResponse]);

  // AI Dispatcher
  const {
    connectionState,
    isThinking,
    streamingText,
    mode,
    connect,
    disconnect,
    sendFrame,
    setMode: setModeInternal,
  } = useAIDispatcher({
    onResponse: handleAIResponse,
    onStreamDelta: (accumulatedText) => {
      // Wire stream early action detection (#3)
      const btnResult = detectActionButtons(canvasRef.current!);
      handleStreamDelta(accumulatedText, btnResult);
    },
    onStreamEnd: () => {},
    onError: (msg, isNetwork) => {
      setErrorMsg(msg);
      if (isNetwork) {
        // Stop capture on network error (#6)
        stopCaptureRef.current?.();
        setIsActive(false);
      } else {
        setTimeout(() => setErrorMsg(''), 3000);
      }
    },
    onConnected: () => {
      // Start capture loop only after WebSocket is connected (#1)
      startLoopRef.current?.();
    },
    onReadyForNextFrame: () => {
      // Auto-resend pending frame (#2)
      const frame = captureOnceRef.current?.();
      if (frame && sendFrameRef.current) {
        sendFrameRef.current(frame, false);
      }
    },
    shouldSuppressStreaming: () => {
      // Suppress streaming text in WAITING/READY phase (#4)
      const phase = uiStateRef.current.phase;
      return phase === 'WAITING' || phase === 'READY';
    },
  });

  // Ref for stopCapture (needed in onError which can't depend on hook return)
  const stopCaptureRef = useRef<(() => void) | null>(null);

  // Sync sendFrame to ref
  useEffect(() => {
    sendFrameRef.current = sendFrame;
  }, [sendFrame]);

  // Handle frame from capture engine - uses ref to avoid dependency cycle
  const handleFrame = useCallback((frame: Frame, btnResult: any, transition: { appeared: boolean; disappeared: boolean; current: boolean }) => {
    setDebugImage(frame.base64);

    if (transition.appeared) {
      console.log(`🟢 Buttons appeared (confidence=${btnResult.confidence})`);
      handleButtonAppeared(); // Pre-increment actionConfirmCount (#8)
    }

    if (transition.disappeared) {
      handleButtonDisappear();
    }

    // READY pre-display: buttons detected while WAITING + have cached analysis (#9)
    if (transition.current && uiStateRef.current.phase === 'WAITING') {
      handleButtonsDetectedWhileWaiting();
    }

    // AUTO mode: automatically send frame to AI
    if (modeRef.current === 'AUTO' && !transition.disappeared && sendFrameRef.current) {
      sendFrameRef.current(frame, transition.appeared);
    }
  }, [handleButtonDisappear, handleButtonAppeared, handleButtonsDetectedWhileWaiting]);

  // Capture engine
  const { start: startCapture, startLoop, stop: stopCapture, captureOnce } = useCaptureEngine({
    videoRef,
    canvasRef,
    onFrame: handleFrame,
    onStreamEnded: () => {
      // Screen share ended → disconnect WebSocket (#7)
      disconnect();
      resetFSM();
    },
  });

  // Sync refs
  useEffect(() => {
    startLoopRef.current = startLoop;
  }, [startLoop]);
  useEffect(() => {
    captureOnceRef.current = captureOnce;
  }, [captureOnce]);
  useEffect(() => {
    stopCaptureRef.current = stopCapture;
  }, [stopCapture]);

  // Update isActive based on connection state
  useEffect(() => {
    setIsActive(connectionState === ConnectionState.CONNECTED);
  }, [connectionState]);

  // Sync mode to ref for use in callbacks
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const setMode = useCallback((newMode: DispatchMode) => {
    modeRef.current = newMode;
    setModeInternal(newMode);
  }, [setModeInternal]);

  // Toggle connection
  const toggleConnection = async () => {
    if (isActive) {
      stopCapture();
      disconnect();
      resetFSM();
      return;
    }

    setErrorMsg('');

    try {
      await startCapture(captureMode);
      await connect();
    } catch (err: any) {
      console.error(err);
      stopCapture(); // Clean up on failure (#6)
      let friendlyMsg = '启动捕获失败';
      if (err.name === 'NotAllowedError') {
        if (captureMode === 'TAB') {
          friendlyMsg = isMacOS()
            ? '屏幕录制权限未开启。请前往：系统设置 → 隐私与安全性 → 屏幕录制，勾选您的浏览器后重启浏览器。或切换为摄像头模式。'
            : '权限被拒绝。请确认浏览器已获得屏幕捕获权限，或尝试摄像头模式。';
        } else {
          friendlyMsg = '摄像头访问被拒绝，请在浏览器设置中允许摄像头权限。';
        }
      } else if (err.message?.includes('disallowed by permissions policy')) {
        friendlyMsg = '浏览器策略阻止了屏幕捕获，请使用摄像头模式或在独立标签页中打开。';
      }
      setErrorMsg(friendlyMsg);
    }
  };

  // Manual detect
  const handleManualDetect = useCallback(() => {
    const frame = captureOnce();
    if (!frame || !sendFrameRef.current) return;
    sendFrameRef.current(frame, true);
  }, [captureOnce]);

  // HMR cleanup
  useEffect(() => {
    return () => {
      stopCapture();
      disconnect();
    };
  }, [stopCapture, disconnect]);

  const getActionBadgeStyle = () => {
    const display = uiState.display.toUpperCase();

    // 根据 display 内容判断具体行动
    if (display.includes('ALL-IN') || display.includes('全压')) {
      return 'bg-purple-600 text-white'; // 全压 - 紫色
    }
    if (display.includes('RAISE') || display.includes('BET') || display.includes('加注')) {
      return 'bg-blue-600 text-white'; // 加注 - 蓝色
    }
    if (display.includes('CALL') || display.includes('跟注')) {
      return 'bg-emerald-600 text-white'; // 跟注 - 绿色
    }
    if (display.includes('CHECK') || display.includes('过牌')) {
      return 'bg-teal-600 text-white'; // 过牌 - 青色
    }
    if (display.includes('FOLD') || display.includes('弃牌')) {
      return 'bg-red-600 text-white'; // 弃牌 - 红色
    }

    // 根据 phase 回退
    switch (uiState.phase) {
      case 'ACTION': return 'bg-blue-600 text-white';
      case 'FOLD': return 'bg-red-600 text-white';
      case 'GOOD': return 'bg-emerald-600 text-white';
      case 'READY': return 'bg-amber-500 text-black';
      default: return 'bg-zinc-700 text-zinc-400';
    }
  };

  const getConnectionIndicator = () => {
    switch (connectionState) {
      case ConnectionState.CONNECTED: return 'bg-green-500 animate-pulse';
      case ConnectionState.CONNECTING: return 'bg-blue-500 animate-pulse';
      case ConnectionState.ERROR: return 'bg-red-500';
      default: return 'bg-zinc-700';
    }
  };

  const getButtonLabel = () => {
    switch (connectionState) {
      case ConnectionState.CONNECTED: return '停止';
      case ConnectionState.CONNECTING: return '连接中...';
      default: return '开始';
    }
  };

  const displayAnalysis = pinnedAnalysis;

  return (
    <div className="flex flex-col h-screen bg-black text-white font-sans overflow-hidden">
      {/* Top Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-900/90 backdrop-blur-xl border-b border-zinc-800 z-50">
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full ${getConnectionIndicator()}`}></div>
          <h1 className="text-lg font-black tracking-tighter italic">GTO<span className="text-blue-500">SIGHT</span></h1>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowPreview(v => !v)}
            className={`px-3 py-1.5 rounded-full text-[10px] font-bold transition-all border ${
              showPreview
                ? 'bg-zinc-700 text-white border-zinc-600'
                : 'bg-zinc-800 text-zinc-500 border-zinc-700'
            }`}
            title={showPreview ? '隐藏画面' : '显示画面'}
          >
            {showPreview ? '隐藏画面' : '显示画面'}
          </button>

          <div className="flex bg-zinc-800 rounded-full p-1 border border-zinc-700">
            <button
              onClick={() => setCaptureMode('TAB')}
              disabled={connectionState !== ConnectionState.DISCONNECTED}
              className={`px-4 py-1.5 rounded-full text-[10px] font-bold transition-all ${captureMode === 'TAB' ? 'bg-zinc-700 text-white shadow-sm' : 'text-zinc-500 opacity-50'}`}
            >
              屏幕
            </button>
            <button
              onClick={() => setCaptureMode('CAMERA')}
              disabled={connectionState !== ConnectionState.DISCONNECTED}
              className={`px-4 py-1.5 rounded-full text-[10px] font-bold transition-all ${captureMode === 'CAMERA' ? 'bg-zinc-700 text-white shadow-sm' : 'text-zinc-500 opacity-50'}`}
            >
              摄像头
            </button>
          </div>

          <button
            onClick={toggleConnection}
            className={`px-6 py-2 rounded-full font-bold text-sm transition-all active:scale-95 ${
              isActive
                ? 'bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/30'
                : connectionState === ConnectionState.CONNECTING
                  ? 'bg-zinc-700 text-zinc-400 cursor-wait'
                  : 'bg-blue-600 hover:bg-blue-500 shadow-lg shadow-blue-500/30'
            }`}
            disabled={connectionState === ConnectionState.CONNECTING}
          >
            {getButtonLabel()}
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="bg-red-500/90 text-white px-6 py-2 text-xs font-bold text-center">
          {errorMsg}
        </div>
      )}

      {/* Main Content: Left/Right Split */}
      <div className="flex-1 flex overflow-hidden">
        <video ref={videoRef} className="hidden" playsInline muted />
        <canvas ref={canvasRef} className="hidden" />

        {/* Left: Screen Preview */}
        {showPreview && (
          <div className="flex-[3] bg-zinc-950 flex items-center justify-center relative border-r border-zinc-800">
            {isActive && debugImage ? (
              <>
                <img src={debugImage} className="w-full h-full object-contain" />
                <div className="absolute top-3 left-3 px-2.5 py-1 bg-red-600/90 text-[10px] font-bold rounded-lg flex items-center gap-1.5 shadow-lg">
                  <div className="w-2 h-2 bg-white rounded-full animate-pulse"></div>
                  LIVE
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center pointer-events-none opacity-20">
                <div className="text-zinc-800 text-[20vw] font-black italic select-none leading-none">GTO</div>
                <p className="text-zinc-600 font-mono text-[10px] tracking-widest mt-4">
                  {captureMode === 'TAB' ? '桌面屏幕同步' : '手机摄像头扫描'}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Right: Strategy Panel */}
        <div className="flex-[2] bg-zinc-900 flex flex-col min-w-[340px] overflow-hidden">

          {/* Status Indicator */}
          {connectionState === ConnectionState.DISCONNECTED ? (
            <div className="flex-shrink-0 flex items-center justify-center px-6 py-2 bg-zinc-800/30 border-b border-zinc-800/30">
              <span className="text-[10px] text-zinc-500 font-mono">点击「开始」启动 AI 分析</span>
            </div>
          ) : uiState.phase === 'WAITING' ? (
            <div className="flex-shrink-0 flex items-center justify-center px-6 py-1.5 bg-zinc-950/80 border-b border-zinc-800/30">
              <span className="text-[10px] text-zinc-600 font-mono tracking-widest">WAITING</span>
            </div>
          ) : null}

          {/* Analysis Area */}
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">

            {displayAnalysis && (
              <div className={`flex flex-col gap-3 transition-opacity duration-300 ${uiState.phase === 'WAITING' ? 'opacity-50' : ''}`}>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: '手牌', value: displayAnalysis.hand || '—' },
                    { label: '位置', value: displayAnalysis.position || '—' },
                    { label: '公共牌', value: displayAnalysis.board || '无' },
                    { label: '阶段', value: displayAnalysis.stage || '—' },
                    { label: '底池', value: displayAnalysis.pot || '—' },
                    { label: '跟注额', value: displayAnalysis.callAmt && displayAnalysis.callAmt !== '0' ? displayAnalysis.callAmt : '—' },
                    { label: '底池赔率', value: displayAnalysis.odds || '—' },
                    { label: 'SPR', value: displayAnalysis.spr || '—' },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-zinc-800/70 rounded-xl px-3 py-2 border border-zinc-700/40">
                      <div className="text-[9px] text-zinc-500 font-bold uppercase tracking-wider mb-0.5">{label}</div>
                      <div className="text-sm text-zinc-200 font-semibold">{value}</div>
                    </div>
                  ))}
                </div>
                {displayAnalysis.detail && (
                  <div className="bg-zinc-800/50 rounded-2xl px-4 py-3 border border-zinc-700/40">
                    <div className="text-[9px] text-zinc-500 font-bold uppercase tracking-wider mb-2">详细分析</div>
                    <p className="text-sm text-zinc-300 leading-relaxed">{displayAnalysis.detail}</p>
                  </div>
                )}
                {uiState.phase !== 'WAITING' && uiState.phase !== 'NEUTRAL' && uiState.display && uiState.display !== '就绪' && uiState.display !== '等待中...' && (
                  <div className={`rounded-2xl px-4 py-4 flex items-center justify-center ${getActionBadgeStyle()}`}>
                    <span className="text-2xl font-black tracking-wide uppercase">{uiState.display}</span>
                  </div>
                )}
              </div>
            )}

            {!displayAnalysis && isThinking && null}
            {!displayAnalysis && !isActive && null}
            {!displayAnalysis && isActive && !isThinking && (
              <div className="flex-1 flex items-center justify-center text-zinc-700 text-xs font-mono italic">
                等待 AI 分析...
              </div>
            )}
          </div>

          {/* Mode Toggle + Manual Detect */}
          {isActive && (
            <div className="flex-shrink-0 px-4 py-3 border-t border-zinc-800/50 flex flex-col gap-2">
              {/* Auto/Manual Toggle */}
              <div className="flex bg-zinc-800 rounded-xl p-1 border border-zinc-700">
                <button
                  onClick={() => setMode('AUTO')}
                  className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${
                    mode === 'AUTO' ? 'bg-green-600 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  自动检测
                </button>
                <button
                  onClick={() => setMode('MANUAL')}
                  className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${
                    mode === 'MANUAL' ? 'bg-amber-600 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  手动检测
                </button>
              </div>
              {/* Manual Mode: Show Detect Button */}
              {mode === 'MANUAL' && (
                <button
                  onClick={handleManualDetect}
                  disabled={isThinking}
                  className={`w-full py-3 rounded-xl font-bold text-sm transition-all active:scale-[0.98] ${
                    isThinking
                      ? 'bg-zinc-700 text-zinc-400 cursor-wait'
                      : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20'
                  }`}
                >
                  {isThinking ? '分析中...' : '检测一次'}
                </button>
              )}
            </div>
          )}

          {/* Footer */}
          <div className="flex-shrink-0 px-4 py-2 border-t border-zinc-800/50 text-[9px] font-mono text-zinc-600 flex justify-between">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
              <span>Qwen-Realtime</span>
            </div>
            <div className="flex gap-3">
              {mode === 'MANUAL' && <span className="text-amber-500">MANUAL</span>}
              <span>{captureMode === 'TAB' ? '屏幕' : '摄像头'}</span>
              <span>{FRAME_RATE}FPS · {MAX_IMAGE_DIMENSION}px</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PokerHUD;
