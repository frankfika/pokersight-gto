
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { QwenStreamService } from '../services/qwenStream';
import { ConnectionState } from '../types';
import { parsePokerResponse, AnalysisData, AdviceType } from '../utils/parseResponse';

const FRAME_RATE = 1.0;
const JPEG_QUALITY = 0.85;
const MAX_IMAGE_DIMENSION = 1024;

type CaptureMode = 'TAB' | 'CAMERA';

const isMacOS = (): boolean =>
  typeof navigator !== 'undefined' &&
  /Mac|Macintosh/i.test(navigator.userAgent);


const PokerHUD: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const serviceRef = useRef<QwenStreamService | null>(null);
  const frameIntervalRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [captureMode, setCaptureMode] = useState<CaptureMode>('TAB');
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [lastAdvice, setLastAdvice] = useState<string>("就绪");
  const [adviceType, setAdviceType] = useState<AdviceType>('NEUTRAL');
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [debugImage, setDebugImage] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [isThinking, setIsThinking] = useState<boolean>(false);
  const [streamingText, setStreamingText] = useState<string>("");

  // 记住上一次"轮到我"的行动建议，WAITING 时保留显示
  const [pinnedAdvice, setPinnedAdvice] = useState<string | null>(null);
  const [pinnedType, setPinnedType] = useState<AdviceType>('NEUTRAL');
  const [pinnedAnalysis, setPinnedAnalysis] = useState<AnalysisData | null>(null);
  const [isWaiting, setIsWaiting] = useState<boolean>(false);

  // 最新帧缓存，供响应驱动发送使用
  const latestFrameRef = useRef<string | null>(null);
  // 上一次实际发送给 AI 的帧（用于变化检测）
  const lastSentFrameRef = useRef<string | null>(null);
  // 防止响应驱动时重入
  const sendingRef = useRef<boolean>(false);

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
    latestFrameRef.current = null;
    lastSentFrameRef.current = null;
    sendingRef.current = false;
    setDebugImage(null);
    setIsThinking(false);
    setStreamingText("");
  }, []);

  const handleTranscription = useCallback((text: string) => {
    const result = parsePokerResponse(text);

    // SKIP = 非牌桌画面，不更新 UI
    if (result.type === 'SKIP') return;

    setLastAdvice(result.display);
    setAdviceType(result.type);
    setStreamingText("");
    if (result.analysis) setAnalysis(result.analysis);

    // 三种状态：WAITING / READY / 轮到我
    const waiting = result.type === 'NEUTRAL';
    setIsWaiting(waiting);
    if (!waiting) {
      // READY 或 轮到我：都钉住建议（READY = 提前算好）
      setPinnedAdvice(result.display);
      setPinnedType(result.type);
      if (result.analysis) setPinnedAnalysis(result.analysis);
    }
  }, []);

  // 捕获最新帧并存入 ref（供响应驱动发送），同时更新预览
  const captureLatestFrame = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx || video.readyState !== 4) return;

    const scale = Math.min(MAX_IMAGE_DIMENSION / video.videoWidth, MAX_IMAGE_DIMENSION / video.videoHeight);
    canvas.width = video.videoWidth * scale;
    canvas.height = video.videoHeight * scale;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const base64 = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    latestFrameRef.current = base64;
    setDebugImage(base64);
  }, []);

  // 简单帧变化检测：比较 base64 字符串长度差异 + 采样比较
  const isFrameChanged = useCallback((newFrame: string, oldFrame: string | null): boolean => {
    if (!oldFrame) return true;
    // 长度差异超过 2% 认为有变化
    const lenDiff = Math.abs(newFrame.length - oldFrame.length) / oldFrame.length;
    if (lenDiff > 0.02) return true;
    // 采样比较：每隔 1000 字符取一个字符，超过 5% 不同则认为有变化
    const step = 1000;
    let diffCount = 0;
    let sampleCount = 0;
    for (let i = 0; i < Math.min(newFrame.length, oldFrame.length); i += step) {
      sampleCount++;
      if (newFrame[i] !== oldFrame[i]) diffCount++;
    }
    return sampleCount === 0 || (diffCount / sampleCount) > 0.05;
  }, []);

  // 发送最新帧给 AI（响应驱动调用）
  const sendLatestFrame = useCallback(() => {
    if (sendingRef.current) return;
    if (!serviceRef.current) return;
    captureLatestFrame();
    if (!latestFrameRef.current) { setTimeout(() => sendLatestFrame(), 500); return; }

    // 帧变化检测：画面无明显变化时延迟重试，不发 AI
    if (!isFrameChanged(latestFrameRef.current, lastSentFrameRef.current)) {
      setTimeout(() => sendLatestFrame(), 2000);
      return;
    }

    lastSentFrameRef.current = latestFrameRef.current;
    sendingRef.current = true;
    setIsThinking(true);
    setStreamingText("");
    serviceRef.current.sendFrame(latestFrameRef.current);
  }, [captureLatestFrame, isFrameChanged]);

  // 预览刷新 interval（纯视觉用，不触发 AI）
  const startPreviewLoop = useCallback(() => {
    if (frameIntervalRef.current) window.clearInterval(frameIntervalRef.current);
    frameIntervalRef.current = window.setInterval(captureLatestFrame, 1000 / FRAME_RATE);
  }, [captureLatestFrame]);

  const toggleConnection = async () => {
    if (connectionState === ConnectionState.CONNECTED || connectionState === ConnectionState.CONNECTING || connectionState === ConnectionState.RECONNECTING) {
      stopCapture();
      serviceRef.current?.disconnect();
      setConnectionState(ConnectionState.DISCONNECTED);
      setLastAdvice("就绪");
      setAdviceType('NEUTRAL');
      setAnalysis(null);
      setIsThinking(false);
      setStreamingText("");
      setPinnedAdvice(null);
      setPinnedType('NEUTRAL');
      setPinnedAnalysis(null);
      setIsWaiting(false);
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
        try {
          await videoRef.current.play();
        } catch (e) {
          console.warn('Video play interrupted:', e);
        }
      }

      stream.getVideoTracks()[0].onended = () => {
        stopCapture();
        serviceRef.current?.disconnect();
        setConnectionState(ConnectionState.DISCONNECTED);
      };

      if (!serviceRef.current) {
        serviceRef.current = new QwenStreamService({
          onStateChange: (state) => {
            setConnectionState(state);
            if (state === ConnectionState.CONNECTED) {
              startPreviewLoop();
              // 连接就绪后立即发第一帧
              setTimeout(() => sendLatestFrame(), 500);
            }
          },
          onTranscription: handleTranscription,
          onDelta: (delta: string) => {
            setStreamingText((prev: string) => prev + delta);
          },
          onResponseDone: () => {
            // 本次响应完成，立即发下一帧（响应驱动）
            sendingRef.current = false;
            setIsThinking(false);
            sendLatestFrame();
          },
          onError: (msg, isNetworkError) => {
            sendingRef.current = false;
            setIsThinking(false);
            setErrorMsg(msg);
            if (isNetworkError) {
              // 网络完全不通 — 设 ERROR，用户需手动重连
              setConnectionState(ConnectionState.ERROR);
            } else {
              // API 错误 — 显示错误消息，3 秒后自动清除
              setTimeout(() => setErrorMsg(""), 3000);
            }
          },
        });
      }

      await serviceRef.current.connect();
    } catch (err: any) {
      console.error(err);
      let friendlyMsg = "启动捕获失败";
      if (err.name === 'NotAllowedError') {
        if (captureMode === 'TAB') {
          friendlyMsg = isMacOS()
            ? "屏幕录制权限未开启。请前往：系统设置 → 隐私与安全性 → 屏幕录制，勾选您的浏览器后重启浏览器。或切换为摄像头模式。"
            : "权限被拒绝。请确认浏览器已获得屏幕捕获权限，或尝试摄像头模式。";
        } else {
          friendlyMsg = "摄像头访问被拒绝，请在浏览器设置中允许摄像头权限。";
        }
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
      case 'READY': return 'bg-amber-500 text-black shadow-[0_0_40px_rgba(245,158,11,0.3)]';
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

  return (
    <div className="flex flex-col h-screen bg-black text-white font-sans overflow-hidden">
      {/* Top Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-900/90 backdrop-blur-xl border-b border-zinc-800 z-50">
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full ${getConnectionIndicator()}`}></div>
          <h1 className="text-lg font-black tracking-tighter italic">GTO<span className="text-blue-500">SIGHT</span></h1>
          {connectionState === ConnectionState.RECONNECTING && (
            <span className="text-[10px] text-yellow-400 font-bold animate-pulse">重连中...</span>
          )}
        </div>

        <div className="flex items-center gap-3">
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

        {/* Left: Screen Preview (large) */}
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

        {/* Right: Strategy Panel */}
        <div className="flex-[2] bg-zinc-900 flex flex-col min-w-[340px] overflow-hidden">

          {/* ① 主行动区 — 轮到我时大字突出，等待时缩小 */}
          {isThinking ? (
            <div className="flex-shrink-0 flex flex-col items-center justify-center py-6 px-6 bg-zinc-800 text-zinc-400 transition-all duration-300">
              <div className="text-[11px] font-bold uppercase tracking-[0.5em] opacity-70 mb-2 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: '0ms' }}></span>
                <span className="w-2 h-2 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: '150ms' }}></span>
                <span className="w-2 h-2 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: '300ms' }}></span>
                <span className="ml-1">AI 分析中</span>
              </div>
              <div className="text-3xl font-black italic">...</div>
            </div>
          ) : isWaiting ? (
            /* 非我的回合 — 简略显示 */
            <div className="flex-shrink-0 flex items-center justify-between px-6 py-3 bg-zinc-800/60 border-b border-zinc-700/30 transition-all duration-300">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-zinc-500 animate-pulse"></span>
                <span className="text-sm text-zinc-400 font-medium">等待对手行动...</span>
              </div>
              <span className="text-[10px] text-zinc-600 font-mono">观察中</span>
            </div>
          ) : adviceType === 'READY' ? (
            /* 即将轮到我 — 黄色预备，提前显示建议 */
            <div className={`flex-shrink-0 flex flex-col items-center justify-center py-6 px-6 transition-all duration-300 ${getAdviceColor()}`}>
              <div className="text-[11px] font-bold uppercase tracking-[0.3em] mb-2 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-black/30 animate-ping"></span>
                即将轮到你
              </div>
              <div className="text-3xl md:text-4xl font-black tracking-tight uppercase italic leading-none text-center">
                {lastAdvice}
              </div>
            </div>
          ) : (
            /* 轮到我 — 大字突出 + 边框 */
            <div className={`flex-shrink-0 flex flex-col items-center justify-center py-10 px-6 transition-all duration-500 ${getAdviceColor()} ring-2 ring-white/20 ring-inset`}>
              <div className="text-[11px] font-bold uppercase tracking-[0.5em] opacity-70 mb-3">GTO 建议</div>
              <div className="text-5xl md:text-6xl font-black tracking-tight uppercase italic leading-none text-center animate-pulse">
                {lastAdvice}
              </div>
            </div>
          )}

          {/* ② 详细分析区 — 可滚动 */}
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">

            {/* 流式文字（AI 正在打字时实时显示） */}
            {isThinking && streamingText && (
              <div className="bg-zinc-800/40 rounded-2xl px-4 py-3 border border-zinc-700/30">
                <div className="text-[9px] text-zinc-500 font-bold uppercase tracking-wider mb-2 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"></span>
                  实时输出
                </div>
                <p className="text-xs text-zinc-400 leading-relaxed font-mono whitespace-pre-wrap">{streamingText}</p>
              </div>
            )}

            {(() => {
              if (isThinking) return null;

              // ── 等待时：只显示分析观察 ──
              if (isWaiting) {
                const detail = analysis?.detail || pinnedAnalysis?.detail;
                if (!detail) return null;
                return (
                  <div className="px-3 py-2 text-sm text-zinc-400 leading-relaxed">
                    {detail}
                  </div>
                );
              }

              // ── 轮到我：完整显示 ──
              if (analysis) {
                return (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { label: '手牌', value: analysis.hand || '—' },
                        { label: '位置', value: analysis.position || '—' },
                        { label: '公共牌', value: analysis.board || '无' },
                        { label: '阶段', value: analysis.stage || '—' },
                        { label: '底池', value: analysis.pot || '—' },
                        { label: '跟注额', value: analysis.callAmt && analysis.callAmt !== '0' ? analysis.callAmt : '—' },
                        { label: '底池赔率', value: analysis.odds || '—' },
                        { label: 'SPR', value: analysis.spr || '—' },
                      ].map(({ label, value }) => (
                        <div key={label} className="bg-zinc-800/70 rounded-xl px-3 py-2 border border-zinc-700/40">
                          <div className="text-[9px] text-zinc-500 font-bold uppercase tracking-wider mb-0.5">{label}</div>
                          <div className="text-sm text-zinc-200 font-semibold">{value}</div>
                        </div>
                      ))}
                    </div>
                    {analysis.detail && (
                      <div className="bg-zinc-800/50 rounded-2xl px-4 py-3 border border-zinc-700/40">
                        <div className="text-[9px] text-zinc-500 font-bold uppercase tracking-wider mb-2">详细分析</div>
                        <p className="text-sm text-zinc-300 leading-relaxed">{analysis.detail}</p>
                      </div>
                    )}
                  </>
                );
              }

              return (
                <div className="flex-1 flex items-center justify-center text-zinc-700 text-xs font-mono italic">
                  {isActive ? '等待 AI 分析...' : '启动后开始分析'}
                </div>
              );
            })()}
          </div>

          {/* ③ 底部信息栏 */}
          <div className="flex-shrink-0 px-4 py-2 border-t border-zinc-800/50 text-[9px] font-mono text-zinc-600 flex justify-between">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
              <span>Qwen-VL-Stream</span>
            </div>
            <div className="flex gap-3">
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
