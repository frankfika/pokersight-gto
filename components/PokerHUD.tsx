
import { useRef, useState, useCallback, useEffect } from 'react';
import { QwenRealtimeService } from '../services/qwenRealtime';
import { ConnectionState } from '../types';
import { parsePokerResponse, AnalysisData, AdviceType } from '../utils/parseResponse';
import { detectActionButtons, detectButtonTransition, ButtonDetectionResult } from '../utils/buttonDetector';

const FRAME_RATE = 1.0;
const JPEG_QUALITY = 0.85;
const MAX_IMAGE_DIMENSION = 1024;

type CaptureMode = 'TAB' | 'CAMERA';

const isMacOS = (): boolean =>
  typeof navigator !== 'undefined' &&
  /Mac|Macintosh/i.test(navigator.userAgent);


const PokerHUD = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const serviceRef = useRef<QwenRealtimeService | null>(null);
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
  const [pinnedAnalysis, setPinnedAnalysis] = useState<AnalysisData | null>(null);
  const [isWaiting, setIsWaiting] = useState<boolean>(false);

  // Ref 镜像 isWaiting，供 useCallback 闭包内访问最新值
  const isWaitingRef = useRef<boolean>(false);
  // Ref 镜像 adviceType，供 sendLatestFrame 判断是否已有有效行动
  const adviceTypeRef = useRef<AdviceType>('NEUTRAL');
  // 流式累积文本 + 早期行动检测标记
  const streamingAccRef = useRef<string>("");
  const earlyActionDetectedRef = useRef<boolean>(false);

  // 去重：记录上一次响应，避免相同状态重复触发UI更新
  const lastStateRef = useRef<{ type: AdviceType; display: string } | null>(null);

  // 最新帧缓存，供响应驱动发送使用
  const latestFrameRef = useRef<string | null>(null);
  // 上一次实际发送给 AI 的帧（用于变化检测）
  const lastSentFrameRef = useRef<string | null>(null);
  // 防止响应驱动时重入
  const sendingRef = useRef<boolean>(false);
  // 帧等待发送（AI 忙时有新变化帧，响应完后立即发）
  const pendingFrameRef = useRef<boolean>(false);
  // 上次发帧时间戳（用于 10s 兜底强制发送）
  const lastSendTimeRef = useRef<number>(0);
  // pinnedAdvice 的 ref 镜像，供 captureAndDispatch 闭包访问
  const pinnedAdviceRef = useRef<string | null>(null);
  // 防闪烁：连续 WAITING 计数，ACTION→WAITING 快速切换时需要 2 次连续确认
  const waitingConfirmCountRef = useRef<number>(0);
  // 防误判：连续 ACTION 计数，WAITING→ACTION 需要 2 次连续确认
  const actionConfirmCountRef = useRef<number>(0);
  // 最新按钮检测结果（每帧更新），供 handleTranscription/onDelta 参考
  const buttonResultRef = useRef<ButtonDetectionResult>({
    hasRedButton: false, hasBlueButton: false, redDensity: 0, confidence: 'LOW',
  });
  // 上一帧是否有按钮（用于状态变化检测）
  const prevButtonStateRef = useRef<boolean>(false);
  // ACTION 状态最近一次设置时间（用于判断是否已稳定）
  const lastActionSetTimeRef = useRef<number>(0);

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
    pendingFrameRef.current = false;
    lastSendTimeRef.current = 0;
    pinnedAdviceRef.current = null;
    adviceTypeRef.current = 'NEUTRAL';
    streamingAccRef.current = "";
    earlyActionDetectedRef.current = false;
    isWaitingRef.current = false;
    lastStateRef.current = null;
    unchangedCountRef.current = 0;
    waitingConfirmCountRef.current = 0;
    actionConfirmCountRef.current = 0;
    buttonResultRef.current = { hasRedButton: false, hasBlueButton: false, redDensity: 0, confidence: 'LOW' };
    prevButtonStateRef.current = false;
    lastActionSetTimeRef.current = 0;
    setDebugImage(null);
    setIsThinking(false);
    setStreamingText("");
  }, []);

  const handleTranscription = useCallback((text: string) => {
    console.log('═══ AI Response ═══');
    console.log(text);
    const result = parsePokerResponse(text);
    console.log('Parsed → Type:', result.type, '| Display:', result.display);

    // SKIP = 非牌桌画面，不更新 UI
    if (result.type === 'SKIP') return;

    // WAITING / READY(预判) → 都视为"非我回合"
    const waiting = result.type === 'NEUTRAL' || result.type === 'READY';

    // ── 防闪烁/防误判：双向确认机制 ──
    if (waiting) {
      waitingConfirmCountRef.current++;
      actionConfirmCountRef.current = 0;
    } else {
      actionConfirmCountRef.current++;
      waitingConfirmCountRef.current = 0;
    }

    // 防闪烁：当前显示 ACTION，AI 说 WAITING
    // 规则：像素无按钮 → 立即接受（两者一致）
    //       像素还有按钮 + ACTION<3s → 需要 2 次确认
    //       ACTION>3s → 立即接受
    const currentlyShowingAction = !isWaitingRef.current &&
      ['ACTION', 'FOLD', 'GOOD'].includes(adviceTypeRef.current);
    if (waiting && currentlyShowingAction) {
      const actionAge = Date.now() - lastActionSetTimeRef.current;
      const buttonsStillVisible = buttonResultRef.current.hasRedButton;
      if (buttonsStillVisible && actionAge < 3000 && waitingConfirmCountRef.current < 2) {
        console.log(`⏸ 防闪烁: WAITING #${waitingConfirmCountRef.current}/2, 按钮仍可见, ACTION刚设置${actionAge}ms前`);
        if (result.type === 'READY') {
          setPinnedAdvice(result.display);
          pinnedAdviceRef.current = result.display;
          if (result.analysis) setPinnedAnalysis(result.analysis);
        }
        return;
      }
      // 像素无按钮 / ACTION已稳定超过3s / 已有2次连续WAITING → 直接清除
      console.log(`✅ WAITING确认（ACTION持续${actionAge}ms, buttons=${buttonsStillVisible}, count=${waitingConfirmCountRef.current}）`);
    }

    // 像素纠错：AI 说 WAITING 但像素检测到红色按钮 → AI 视觉错误，拒绝并更新分析数据
    if (waiting && buttonResultRef.current.hasRedButton) {
      console.log(`⚠️ AI说WAITING但像素检测到红色按钮 (confidence=${buttonResultRef.current.confidence}, density=${buttonResultRef.current.redDensity.toFixed(4)})，拒绝WAITING`);
      // 仍然更新分析数据（手牌/底池等信息可能有用）
      if (result.analysis) {
        setPinnedAnalysis(result.analysis);
      }
      return;
    }

    // 防误判：当前 WAITING，AI 说 ACTION → 根据像素置信度决定确认次数
    // HIGH(红+蓝) = 1次，MEDIUM(红) = 1次，LOW(无按钮) = 2次
    const currentlyWaiting = isWaitingRef.current;
    if (!waiting && currentlyWaiting) {
      const confidence = buttonResultRef.current.confidence;
      const requiredConfirms = confidence === 'HIGH' ? 1 : confidence === 'MEDIUM' ? 1 : 2;
      if (actionConfirmCountRef.current < requiredConfirms) {
        console.log(`⏸ 防误判: ACTION #${actionConfirmCountRef.current}/${requiredConfirms} (confidence=${confidence}), 暂不切换`);
        return;
      }
      console.log(`✅ ACTION确认 (confidence=${confidence}, count=${actionConfirmCountRef.current})`);
    }

    // 去重：避免相同状态重复触发UI更新（但 analysis 始终更新）
    const lastState = lastStateRef.current;
    let isDuplicate = false;
    if (lastState) {
      const wasWaiting = lastState.type === 'NEUTRAL' || lastState.type === 'READY';
      const isNowWaiting = waiting;
      if (wasWaiting && isNowWaiting) {
        isDuplicate = true;
      } else if (lastState.type === result.type && lastState.display === result.display) {
        isDuplicate = true;
      }
    }

    // 即使是重复状态，也始终更新 analysis 数据（牌面/底池等可能已变）
    if (result.analysis) {
      if (waiting) {
        setPinnedAnalysis(result.analysis);
      } else {
        setAnalysis(result.analysis);
        setPinnedAnalysis(result.analysis);
      }
    }

    if (isDuplicate) {
      console.log('⏭ Same action, analysis updated only');
      return;
    }

    lastStateRef.current = { type: result.type, display: result.display };
    console.log('✅ State changed:', result.type, '→', result.display);
    console.log('═══════════════════');

    setStreamingText("");

    if (waiting) {
      // 非我回合：强制切到 WAITING，清除旧行动显示
      setIsWaiting(true);
      isWaitingRef.current = true;
      setLastAdvice('等待中...');
      setAdviceType('NEUTRAL');
      adviceTypeRef.current = 'NEUTRAL';
      setIsThinking(false);
      if (result.type === 'READY') {
        setPinnedAdvice(result.display);
        pinnedAdviceRef.current = result.display;
      }
    } else {
      // 轮到我（ACTION/FOLD/GOOD）— 直接信任 AI，立即显示
      lastActionSetTimeRef.current = Date.now();
      setIsWaiting(false);
      isWaitingRef.current = false;
      setLastAdvice(result.display);
      setAdviceType(result.type);
      adviceTypeRef.current = result.type;
      setPinnedAdvice(result.display);
      pinnedAdviceRef.current = result.display;
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

  // 连续未变化计数，用于渐进式退避
  const unchangedCountRef = useRef<number>(0);

  // 简单帧变化检测：比较 base64 字符串长度差异 + 采样比较
  const isFrameChanged = useCallback((newFrame: string, oldFrame: string | null): boolean => {
    if (!oldFrame) return true;
    // 长度差异超过 12% 认为有变化（过滤掉动画/计时器等微小变化）
    const lenDiff = Math.abs(newFrame.length - oldFrame.length) / oldFrame.length;
    if (lenDiff > 0.12) return true;
    // 采样比较：每隔 800 字符取一个字符，超过 25% 不同则认为有变化
    const step = 800;
    let diffCount = 0;
    let sampleCount = 0;
    for (let i = 0; i < Math.min(newFrame.length, oldFrame.length); i += step) {
      sampleCount++;
      if (newFrame[i] !== oldFrame[i]) diffCount++;
    }
    return sampleCount === 0 || (diffCount / sampleCount) > 0.25;
  }, []);

  // 纯发送：将 latestFrameRef 发给 AI（不截帧、不调度）
  // force=true 时跳过冷却（按钮变化等高优先级事件）
  const sendFrameToAI = useCallback((force = false) => {
    if (sendingRef.current || !serviceRef.current || !latestFrameRef.current) return;
    // 最小发送间隔 3 秒（force 时跳过）
    if (!force && lastSendTimeRef.current > 0) {
      const sinceLastSend = Date.now() - lastSendTimeRef.current;
      if (sinceLastSend < 3000) return;
    }
    sendingRef.current = true;
    lastSentFrameRef.current = latestFrameRef.current;
    lastSendTimeRef.current = Date.now();
    pendingFrameRef.current = false;
    unchangedCountRef.current = 0;
    // 重置流式累积
    streamingAccRef.current = "";
    earlyActionDetectedRef.current = false;
    // thinking 状态仅在非WAITING且无有效行动时显示
    const hasAction = ['ACTION', 'FOLD', 'GOOD', 'READY'].includes(adviceTypeRef.current);
    if (!isWaitingRef.current && !hasAction) {
      setIsThinking(true);
      setStreamingText("");
    }
    serviceRef.current.sendFrame(latestFrameRef.current);
  }, []);

  // 事件驱动帧调度：每秒截帧 + 帧差检测 + 按钮检测 + 智能发送
  const startCaptureLoop = useCallback(() => {
    if (frameIntervalRef.current) window.clearInterval(frameIntervalRef.current);
    frameIntervalRef.current = window.setInterval(() => {
      // 1. 截帧并更新预览
      captureLatestFrame();
      if (!latestFrameRef.current || !canvasRef.current) return;

      // 2. 帧差检测
      const changed = isFrameChanged(latestFrameRef.current, lastSentFrameRef.current);

      if (changed) {
        // 3a. 画面有变化：做按钮检测（增强版）
        const btnResult = detectActionButtons(canvasRef.current);
        buttonResultRef.current = btnResult;

        // 检测按钮状态变化（出现/消失）
        const transition = detectButtonTransition(prevButtonStateRef.current, btnResult);
        prevButtonStateRef.current = transition.current;

        if (transition.appeared) {
          console.log(`🟢 按钮出现 (confidence=${btnResult.confidence}, red=${btnResult.redDensity.toFixed(4)})`);
          // 预设确认计数，加速 WAITING→ACTION 转换
          actionConfirmCountRef.current = Math.max(actionConfirmCountRef.current, 1);
        }
        if (transition.disappeared) {
          console.log(`🔴 按钮消失`);
          // 预设确认计数，加速 ACTION→WAITING 转换
          waitingConfirmCountRef.current = Math.max(waitingConfirmCountRef.current, 1);
        }

        if (transition.current && isWaitingRef.current && pinnedAdviceRef.current) {
          // 检测到按钮 + 正在等待 + 有缓存的预判建议 → 立即显示 READY
          console.log('🎯 按钮检测到 + 有缓存READY → 立即显示');
          setIsWaiting(false);
          isWaitingRef.current = false;
          setLastAdvice(pinnedAdviceRef.current);
          setAdviceType('READY');
          adviceTypeRef.current = 'READY';
          lastStateRef.current = null;
        }

        // 3b. 按钮状态变化时优先发帧（高优先级事件，跳过冷却）
        const shouldPrioritySend = transition.appeared || transition.disappeared;
        if (!sendingRef.current) {
          sendFrameToAI(shouldPrioritySend);
        } else if (shouldPrioritySend) {
          // 按钮变化是高优先级，标记 pending 确保响应完后立即发
          pendingFrameRef.current = true;
        } else {
          pendingFrameRef.current = true;
        }
      } else {
        // 4. 画面没变化
        const elapsed = Date.now() - lastSendTimeRef.current;
        if (elapsed > 15000 && !sendingRef.current) {
          // 超过 15s 未发帧 → 强制发一次（安全兜底）
          console.log('⏰ 15s 兜底发送');
          sendFrameToAI();
        }
        // 否则跳过
      }
    }, 1000 / FRAME_RATE);
  }, [captureLatestFrame, isFrameChanged, sendFrameToAI]);

  const toggleConnection = async () => {
    if (connectionState !== ConnectionState.DISCONNECTED && connectionState !== ConnectionState.ERROR) {
      stopCapture();
      serviceRef.current?.disconnect();
      setConnectionState(ConnectionState.DISCONNECTED);
      setLastAdvice("就绪");
      setAdviceType('NEUTRAL');
      setAnalysis(null);
      setPinnedAdvice(null);
      pinnedAdviceRef.current = null;
      setPinnedAnalysis(null);
      setIsWaiting(false);
      adviceTypeRef.current = 'NEUTRAL';
      streamingAccRef.current = "";
      earlyActionDetectedRef.current = false;
      isWaitingRef.current = false;
      lastStateRef.current = null;
      waitingConfirmCountRef.current = 0;
      actionConfirmCountRef.current = 0;
      buttonResultRef.current = { hasRedButton: false, hasBlueButton: false, redDensity: 0, confidence: 'LOW' };
      prevButtonStateRef.current = false;
      lastActionSetTimeRef.current = 0;
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
        serviceRef.current = new QwenRealtimeService({
          onStateChange: (state) => {
            setConnectionState(state);
            if (state === ConnectionState.CONNECTED) {
              // 启动事件驱动帧调度循环（含预览+帧差+按钮检测+AI发送）
              startCaptureLoop();
            }
          },
          onTranscription: handleTranscription,
          onDelta: (delta: string) => {
            streamingAccRef.current += delta;
            // WAITING/READY: 抑制流式文字显示，但继续做早期行动检测
            if (!isWaitingRef.current && adviceTypeRef.current !== 'READY') {
              setStreamingText((prev: string) => prev + delta);
            }
            // 流式早期行动检测：ACTION 行一出现就立即显示，不等完整响应
            if (!earlyActionDetectedRef.current) {
              const m = streamingAccRef.current.match(/ACTION[:：]\s*(CHECK|FOLD|CALL|RAISE|ALLIN|BET|WAITING|SKIP)/i);
              if (m) {
                earlyActionDetectedRef.current = true;
                const earlyResult = parsePokerResponse(streamingAccRef.current);
                if (earlyResult.type !== 'SKIP') {
                  const w = earlyResult.type === 'NEUTRAL' || earlyResult.type === 'READY';
                  if (w) {
                    // 防闪烁：ACTION→WAITING 需要连续确认（与 handleTranscription 一致）
                    waitingConfirmCountRef.current++;
                    const showingAction = !isWaitingRef.current &&
                      ['ACTION', 'FOLD', 'GOOD'].includes(adviceTypeRef.current);
                    const buttonsStillVisible = buttonResultRef.current.hasRedButton;
                    const actionAge = Date.now() - lastActionSetTimeRef.current;
                    if (showingAction && buttonsStillVisible && actionAge < 3000 && waitingConfirmCountRef.current < 2) {
                      // 暂不切换，按钮仍可见且ACTION刚设置
                    } else {
                      setIsWaiting(true);
                      isWaitingRef.current = true;
                      setLastAdvice('等待中...');
                      setAdviceType('NEUTRAL');
                      adviceTypeRef.current = 'NEUTRAL';
                      setIsThinking(false);
                    }
                  } else {
                    // 轮到我 — 根据像素置信度决定确认次数
                    actionConfirmCountRef.current++;
                    waitingConfirmCountRef.current = 0;
                    const confidence = buttonResultRef.current.confidence;
                    const requiredConfirms = confidence === 'HIGH' ? 1 : confidence === 'MEDIUM' ? 1 : 2;
                    if (isWaitingRef.current && actionConfirmCountRef.current < requiredConfirms) {
                      // 暂不切换，等更多确认
                    } else {
                      setIsWaiting(false);
                      isWaitingRef.current = false;
                      setIsThinking(false);
                      setLastAdvice(earlyResult.display);
                      setAdviceType(earlyResult.type);
                      adviceTypeRef.current = earlyResult.type;
                      setPinnedAdvice(earlyResult.display);
                      pinnedAdviceRef.current = earlyResult.display;
                    }
                  }
                }
              }
            }
          },
          onResponseDone: () => {
            sendingRef.current = false;
            setIsThinking(false);
            // 有等待中的帧 → 立即发送
            if (pendingFrameRef.current) {
              pendingFrameRef.current = false;
              sendFrameToAI();
            }
            // 否则什么都不做 — 等 captureAndDispatch 检测到下一次变化
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

  // HMR / unmount 清理：确保旧的 WebSocket 和采集循环被正确释放
  useEffect(() => {
    return () => {
      stopCapture();
      serviceRef.current?.disconnect();
      serviceRef.current = null;
    };
  }, [stopCapture]);

  const getActionBadgeStyle = () => {
    switch (adviceType) {
      case 'ACTION': return 'bg-blue-600 text-white';
      case 'FOLD': return 'bg-red-600 text-white';
      case 'GOOD': return 'bg-emerald-600 text-white';
      case 'READY': return 'bg-amber-500 text-black';
      default: return 'bg-zinc-700 text-zinc-400';
    }
  };

  const getConnectionIndicator = () => {
    switch (connectionState) {
      case ConnectionState.CONNECTED:
        return 'bg-green-500 animate-pulse';
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
        return '停止';
      case ConnectionState.CONNECTING:
        return '连接中...';
      default:
        return '开始';
    }
  };

  const isActive = connectionState === ConnectionState.CONNECTED;

  return (
    <div className="flex flex-col h-screen bg-black text-white font-sans overflow-hidden">
      {/* Top Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-900/90 backdrop-blur-xl border-b border-zinc-800 z-50">
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full ${getConnectionIndicator()}`}></div>
          <h1 className="text-lg font-black tracking-tighter italic">GTO<span className="text-blue-500">SIGHT</span></h1>
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

          {/* ① 状态指示条 — 极简 */}
          {connectionState === ConnectionState.DISCONNECTED ? (
            <div className="flex-shrink-0 flex items-center justify-center px-6 py-2 bg-zinc-800/30 border-b border-zinc-800/30">
              <span className="text-[10px] text-zinc-500 font-mono">点击「开始」启动 AI 分析</span>
            </div>
          ) : isWaiting ? (
            <div className="flex-shrink-0 flex items-center justify-center px-6 py-1.5 bg-zinc-950/80 border-b border-zinc-800/30">
              <span className="text-[10px] text-zinc-600 font-mono tracking-widest">WAITING</span>
            </div>
          ) : null}

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
              const displayAnalysis = pinnedAnalysis;

              // 有分析数据 → 始终显示，WAITING 时降低视觉权重
              if (displayAnalysis) {
                return (
                  <div className={`flex flex-col gap-3 transition-opacity duration-300 ${isWaiting ? 'opacity-50' : ''}`}>
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
                    {/* 行动总结 — 从分析得出 */}
                    {!isWaiting && adviceType !== 'NEUTRAL' && lastAdvice && lastAdvice !== '就绪' && lastAdvice !== '等待中...' && (
                      <div className={`rounded-2xl px-4 py-4 flex items-center justify-center ${getActionBadgeStyle()}`}>
                        <span className="text-2xl font-black tracking-wide uppercase">{lastAdvice}</span>
                      </div>
                    )}
                  </div>
                );
              }

              // 无数据时的占位
              if (isThinking) return null;
              if (!isActive) return null;
              return (
                <div className="flex-1 flex items-center justify-center text-zinc-700 text-xs font-mono italic">
                  等待 AI 分析...
                </div>
              );
            })()}
          </div>

          {/* ③ 底部信息栏 */}
          <div className="flex-shrink-0 px-4 py-2 border-t border-zinc-800/50 text-[9px] font-mono text-zinc-600 flex justify-between">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
              <span>Qwen-Realtime</span>
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
