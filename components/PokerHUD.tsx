
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { GeminiLiveService } from '../services/geminiLive';
import { ConnectionState, SessionStatus } from '../types';

const FRAME_RATE = 1.0;
const JPEG_QUALITY = 0.80;
const MAX_IMAGE_DIMENSION = 768;

type CaptureMode = 'TAB' | 'CAMERA';

/** Map English actions to bilingual display */
const ACTION_LABELS: Record<string, string> = {
  FOLD: '弃牌 FOLD',
  CHECK: '过牌 CHECK',
  CALL: '跟注 CALL',
  RAISE: '加注 RAISE',
  'ALL-IN': '全压 ALL-IN',
  WAITING: '等待中...',
};

const PokerHUD: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const serviceRef = useRef<GeminiLiveService | null>(null);
  const frameIntervalRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [captureMode, setCaptureMode] = useState<CaptureMode>('TAB');
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [lastAdvice, setLastAdvice] = useState<string>("就绪");
  const [adviceType, setAdviceType] = useState<'NEUTRAL' | 'ACTION' | 'FOLD' | 'GOOD' | 'WARNING'>('NEUTRAL');
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [debugImage, setDebugImage] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>({ remainingSeconds: 115, reconnectCount: 0 });

  const stopCapture = useCallback(() => {
    if (frameIntervalRef.current) {
      window.clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setDebugImage(null);
  }, []);

  const handleTranscription = useCallback((text: string) => {
    const cleanText = text.replace(/[^a-zA-Z0-9\s\-\u4e00-\u9fff]/g, '').toUpperCase().trim();
    if (!cleanText) return;

    let type: 'NEUTRAL' | 'ACTION' | 'FOLD' | 'GOOD' | 'WARNING' = 'NEUTRAL';
    let display = "";

    if (cleanText.includes("WAIT") || cleanText.includes("等待")) {
      type = 'NEUTRAL';
      display = ACTION_LABELS['WAITING'];
    } else if (cleanText.includes("FOLD") || cleanText.includes("弃牌")) {
      type = 'FOLD';
      display = ACTION_LABELS['FOLD'];
    } else if (cleanText.includes("ALL-IN") || cleanText.includes("ALLIN") || cleanText.includes("全压")) {
      type = 'ACTION';
      display = ACTION_LABELS['ALL-IN'];
    } else if (cleanText.includes("RAISE") || cleanText.includes("BET") || cleanText.includes("加注")) {
      const match = cleanText.match(/(RAISE|BET|加注)\s*(\d+)/);
      type = 'ACTION';
      display = match ? `加注 RAISE ${match[2]}` : ACTION_LABELS['RAISE'];
    } else if (cleanText.includes("CHECK") || cleanText.includes("过牌")) {
      type = 'GOOD';
      display = ACTION_LABELS['CHECK'];
    } else if (cleanText.includes("CALL") || cleanText.includes("跟注")) {
      type = 'GOOD';
      display = ACTION_LABELS['CALL'];
    } else if (cleanText.includes("NO DATA") || cleanText.includes("ERROR")) {
      type = 'WARNING';
      display = "无信号";
    } else {
      return;
    }

    setLastAdvice(display);
    setAdviceType(type);
  }, []);

  const startFrameLoop = useCallback(() => {
    if (frameIntervalRef.current) window.clearInterval(frameIntervalRef.current);
    frameIntervalRef.current = window.setInterval(() => {
      if (!videoRef.current || !canvasRef.current || !serviceRef.current) return;

      const video = videoRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx || video.readyState !== 4) return;

      const scale = Math.min(MAX_IMAGE_DIMENSION / video.videoWidth, MAX_IMAGE_DIMENSION / video.videoHeight);
      canvas.width = video.videoWidth * scale;
      canvas.height = video.videoHeight * scale;

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const base64 = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      setDebugImage(base64);
      serviceRef.current.sendFrame(base64);
    }, 1000 / FRAME_RATE);
  }, []);

  const toggleConnection = async () => {
    if (connectionState === ConnectionState.CONNECTED || connectionState === ConnectionState.CONNECTING || connectionState === ConnectionState.RECONNECTING) {
      stopCapture();
      serviceRef.current?.disconnect();
      setConnectionState(ConnectionState.DISCONNECTED);
      setLastAdvice("就绪");
      setAdviceType('NEUTRAL');
      setSessionStatus({ remainingSeconds: 115, reconnectCount: 0 });
      return;
    }

    setErrorMsg("");
    setConnectionState(ConnectionState.CONNECTING);

    try {
      let stream: MediaStream;

      if (captureMode === 'TAB') {
        if (!navigator.mediaDevices?.getDisplayMedia) {
          throw new Error("此设备/浏览器不支持屏幕捕获");
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
        videoRef.current.play();
      }

      stream.getVideoTracks()[0].onended = () => {
        stopCapture();
        serviceRef.current?.disconnect();
        setConnectionState(ConnectionState.DISCONNECTED);
      };

      if (!serviceRef.current) {
        serviceRef.current = new GeminiLiveService({
          onStateChange: setConnectionState,
          onTranscription: handleTranscription,
          onError: (msg) => {
            setErrorMsg(msg);
            setConnectionState(ConnectionState.ERROR);
          },
          onSessionStatus: setSessionStatus,
        });
      }

      await serviceRef.current.connect();
      startFrameLoop();
    } catch (err: any) {
      console.error(err);
      let friendlyMsg = "启动捕获失败";
      if (err.name === 'NotAllowedError') {
        friendlyMsg = captureMode === 'TAB'
          ? "权限被拒绝。浏览器可能因安全策略阻止了屏幕捕获，请尝试摄像头模式。"
          : "摄像头访问被拒绝";
      } else if (err.message?.includes("disallowed by permissions policy")) {
        friendlyMsg = "浏览器策略阻止了屏幕捕获，请使用摄像头模式或在独立标签页中打开。";
      }

      setErrorMsg(friendlyMsg);
      setConnectionState(ConnectionState.ERROR);
      stopCapture();
    }
  };

  const getAdviceColor = () => {
    switch (adviceType) {
      case 'ACTION': return 'bg-blue-600 text-white shadow-[0_0_60px_rgba(37,99,235,0.4)]';
      case 'FOLD': return 'bg-red-600 text-white';
      case 'GOOD': return 'bg-emerald-600 text-white';
      case 'WARNING': return 'bg-amber-600 text-white';
      default: return 'bg-zinc-800 text-zinc-400';
    }
  };

  const getConnectionIndicator = () => {
    switch (connectionState) {
      case ConnectionState.CONNECTED:
        return 'bg-green-500 animate-pulse';
      case ConnectionState.RECONNECTING:
        return 'bg-yellow-500 animate-pulse';
      case ConnectionState.CONNECTING:
        return 'bg-blue-500 animate-pulse';
      case ConnectionState.ERROR:
        return 'bg-red-500';
      default:
        return 'bg-zinc-700';
    }
  };

  const getButtonLabel = () => {
    switch (connectionState) {
      case ConnectionState.CONNECTED:
      case ConnectionState.RECONNECTING:
        return '停止';
      case ConnectionState.CONNECTING:
        return '连接中...';
      default:
        return '开始';
    }
  };

  const isActive = connectionState === ConnectionState.CONNECTED || connectionState === ConnectionState.RECONNECTING;

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex flex-col h-screen bg-black text-white font-sans overflow-hidden">
      {/* Top Header */}
      <div className="flex items-center justify-between p-4 bg-zinc-900/90 backdrop-blur-xl border-b border-zinc-800 z-50">
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full ${getConnectionIndicator()}`}></div>
          <h1 className="text-lg font-black tracking-tighter italic">GTO<span className="text-blue-500">SIGHT</span></h1>
          {connectionState === ConnectionState.RECONNECTING && (
            <span className="text-[10px] text-yellow-400 font-bold animate-pulse">重连中...</span>
          )}
        </div>

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

      {/* Session Status Bar */}
      {isActive && (
        <div className="flex items-center justify-center gap-6 py-1.5 bg-zinc-900/60 border-b border-zinc-800/50 text-[10px] font-mono">
          <span className={`${sessionStatus.remainingSeconds <= 15 ? 'text-red-400 animate-pulse' : 'text-zinc-500'}`}>
            Session {formatTime(sessionStatus.remainingSeconds)}
          </span>
          {sessionStatus.reconnectCount > 0 && (
            <span className="text-zinc-600">
              重连 {sessionStatus.reconnectCount} 次
            </span>
          )}
        </div>
      )}

      {/* Main Analysis Area */}
      <div className="flex-1 flex flex-col items-center justify-center relative p-6">
        <video ref={videoRef} className="hidden" playsInline muted />
        <canvas ref={canvasRef} className="hidden" />

        {errorMsg && (
          <div className="absolute top-10 left-1/2 -translate-x-1/2 bg-red-500/90 text-white px-6 py-3 rounded-2xl text-xs font-bold text-center max-w-xs shadow-2xl z-50">
            {errorMsg}
          </div>
        )}

        <div className="flex flex-col items-center gap-6 z-10 w-full max-w-lg">
          <span className="text-[10px] text-zinc-600 font-bold uppercase tracking-[0.6em]">系统建议</span>
          <div className={`w-full py-20 md:py-32 rounded-[3.5rem] text-center transition-all duration-700 border-4 border-white/5 shadow-2xl ${getAdviceColor()}`}>
            <div className="text-5xl md:text-7xl font-black tracking-tighter uppercase italic">
              {lastAdvice}
            </div>
          </div>
        </div>

        {/* Live Preview Window */}
        {isActive && (
          <div className="absolute bottom-8 right-8 animate-in fade-in zoom-in duration-500">
            <div className="w-56 aspect-video bg-zinc-900 rounded-2xl overflow-hidden border-2 border-zinc-800 shadow-2xl relative">
              {debugImage ? (
                <img src={debugImage} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-[10px] text-zinc-700 font-mono italic">同步中...</div>
              )}
              <div className="absolute top-2 left-2 px-2 py-0.5 bg-red-600 text-[8px] font-bold rounded flex items-center gap-1 shadow-lg">
                <div className="w-1.5 h-1.5 bg-white rounded-full animate-pulse"></div>
                AI 识别
              </div>
            </div>
          </div>
        )}

        {/* Empty state decoration */}
        {connectionState === ConnectionState.DISCONNECTED && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none opacity-20">
             <div className="text-zinc-800 text-[25vw] font-black italic select-none leading-none">GTO</div>
             <p className="text-zinc-600 font-mono text-[10px] tracking-widest mt-4">
               {captureMode === 'TAB' ? '桌面屏幕同步' : '手机摄像头扫描'}
             </p>
          </div>
        )}
      </div>

      {/* Footer Info */}
      <div className="p-6 bg-zinc-900/50 border-t border-zinc-800/50 flex justify-between items-center text-[10px] font-mono text-zinc-600 uppercase tracking-widest">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-blue-500"></span>
          <span>引擎: Gemini 2.0 Flash Lite</span>
        </div>
        <div className="flex items-center gap-4">
          <span>模式: {captureMode === 'TAB' ? '屏幕' : '摄像头'}</span>
          <span>FPS: {FRAME_RATE.toFixed(0)}</span>
          <span>{MAX_IMAGE_DIMENSION}px</span>
        </div>
      </div>
    </div>
  );
};

export default PokerHUD;
