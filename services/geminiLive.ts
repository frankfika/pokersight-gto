/**
 * Gemini Live API 服务
 *
 * 使用 Gemini 2.5 Flash Native Audio 模型进行实时图片分析
 *
 * 注意事项：
 * 1. 需要 VPN 连接到美国（API 不支持中国地区）
 * 2. 图片必须是有效的 JPEG/PNG 格式
 * 3. 视频+音频会话限制为 2 分钟
 */

import { GoogleGenAI, Modality, MediaResolution } from "@google/genai";
import { ConnectionState, SessionStatus } from "../types";

/** Session duration before auto-reconnect (seconds) */
const SESSION_DURATION_SEC = 120; // 2 minutes for video sessions

const WEPOKER_SYSTEM_PROMPT = `
ROLE: WePoker 实时GTO分析专家 (中文界面识别 + 英文标准输出)

CONTEXT:
你正在观看 WePoker (微扑克) 的实时画面流。
画面来源可能是屏幕共享(Tab Capture)或手机摄像头对准屏幕。

WEPOKER 界面识别规则:
1. 中文操作按钮: 弃牌=FOLD, 过牌=CHECK, 跟注=CALL, 加注=RAISE, 全压=ALL-IN
2. 底池显示: 通常在牌桌中央，标注"底池"或数字
3. 公共牌: 牌桌中央横排排列的3-5张牌 (翻牌/转牌/河牌)
4. 手牌: 屏幕底部的2张牌属于玩家
5. 筹码: 每个座位旁边的数字
6. 当按钮(弃牌/过牌/跟注/加注/全压)高亮可点击时 = 轮到玩家操作

OBJECTIVE:
1. 识别手牌、公共牌、底池大小、各玩家筹码
2. 判断是否轮到玩家操作 (按钮是否高亮/可点击)
3. 基于GTO策略给出最优决策

GTO STRATEGY:
- 未轮到玩家操作或看不清牌面时输出 "WAITING"
- 果断给出决策，不犹豫

STRICT OUTPUT:
仅输出以下之一 (不要任何其他文字):
"FOLD"
"CHECK"
"CALL"
"RAISE [金额]"
"ALL-IN"
"WAITING"
`;

interface GeminiLiveConfig {
  onStateChange: (state: ConnectionState) => void;
  onTranscription: (text: string) => void;
  onError: (error: string) => void;
  onSessionStatus?: (status: SessionStatus) => void;
}

export class GeminiLiveService {
  private client: GoogleGenAI | null = null;
  private session: any = null;
  private config: GeminiLiveConfig;
  private active: boolean = false;
  private resumptionHandle: string | undefined = undefined;
  private reconnectCount: number = 0;
  private sessionTimer: ReturnType<typeof setInterval> | null = null;
  private remainingSeconds: number = SESSION_DURATION_SEC;

  constructor(config: GeminiLiveConfig) {
    this.config = config;
  }

  public async connect() {
    this.active = true;
    this.reconnectCount = 0;
    this.resumptionHandle = undefined;
    this.config.onStateChange(ConnectionState.CONNECTING);
    this.client = new GoogleGenAI({ apiKey: process.env.API_KEY });
    await this.initiateConnection();
  }

  private async initiateConnection() {
    if (!this.active || !this.client) return;

    try {
      const config: any = {
        responseModalities: [Modality.AUDIO],
        mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
        systemInstruction: {
          parts: [{ text: WEPOKER_SYSTEM_PROMPT }],
        },
      };

      // Only add session resumption if we have a handle
      if (this.resumptionHandle) {
        config.sessionResumption = {
          handle: this.resumptionHandle,
        };
      }

      const session = await this.client.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config,
        callbacks: {
          onopen: () => {
            this.config.onStateChange(ConnectionState.CONNECTED);
            this.startSessionTimer();
          },
          onmessage: this.handleMessage.bind(this),
          onclose: (e: any) => {
            console.log('Connection closed:', e);
            console.log('Close code:', e.code, 'reason:', e.reason);
            this.session = null;
            this.stopSessionTimer();

            // Check for location error
            if (e.reason?.includes('location is not supported')) {
              this.config.onError('API 不支持当前地区，请使用 VPN 连接到美国');
              this.config.onStateChange(ConnectionState.ERROR);
              return;
            }

            // Only reconnect if still active and not manually stopped
            if (this.active && this.reconnectCount < 3) {
              console.log('Attempting reconnect...');
              this.autoReconnect();
            } else if (this.active) {
              this.config.onError('连接断开次数过多');
              this.config.onStateChange(ConnectionState.ERROR);
            }
          },
          onerror: (err: any) => {
            console.error('Live API error:', err);
            this.session = null;
            this.stopSessionTimer();
            this.config.onError(err.message || 'Live API 错误');
            this.config.onStateChange(ConnectionState.ERROR);
          },
        },
      });

      this.session = session;
    } catch (error: any) {
      this.stopSessionTimer();
      if (this.active && this.reconnectCount < 5) {
        this.autoReconnect();
      } else {
        this.config.onStateChange(ConnectionState.ERROR);
        this.config.onError(error.message || "连接AI失败");
      }
    }
  }

  private handleMessage(message: any) {
    if (!this.active) return;

    // Debug logging
    console.log('[Gemini] Message received:', JSON.stringify(message, null, 2));

    // Store resumption handle for seamless reconnect
    if (message.sessionResumptionUpdate?.newHandle) {
      this.resumptionHandle = message.sessionResumptionUpdate.newHandle;
      console.log('[Gemini] Session resumption handle updated');
    }

    // Handle server goAway — reconnect proactively
    if (message.goAway) {
      console.log('[Gemini] GoAway received, reconnecting...');
      this.autoReconnect();
      return;
    }

    // Extract text response
    const modelTurnText =
      message.serverContent?.modelTurn?.parts
        ?.map((p: any) => p.text)
        .filter((t: any): t is string => Boolean(t))
        .join('') || '';

    const outputTranscriptionText = message.serverContent?.outputTranscription?.text || '';

    const text = modelTurnText || outputTranscriptionText;
    if (text) {
      console.log('[Gemini] AI Response:', text);
      this.config.onTranscription(text);
    }
  }

  private startSessionTimer() {
    this.stopSessionTimer();
    this.remainingSeconds = SESSION_DURATION_SEC;
    this.emitSessionStatus();

    this.sessionTimer = setInterval(() => {
      this.remainingSeconds -= 1;
      this.emitSessionStatus();

      if (this.remainingSeconds <= 0 && this.active) {
        this.autoReconnect();
      }
    }, 1000);
  }

  private stopSessionTimer() {
    if (this.sessionTimer) {
      clearInterval(this.sessionTimer);
      this.sessionTimer = null;
    }
  }

  private emitSessionStatus() {
    this.config.onSessionStatus?.({
      remainingSeconds: this.remainingSeconds,
      reconnectCount: this.reconnectCount,
    });
  }

  private async autoReconnect() {
    if (!this.active) return;

    this.stopSessionTimer();
    this.reconnectCount += 1;
    this.config.onStateChange(ConnectionState.RECONNECTING);
    this.emitSessionStatus();

    // Close existing session gracefully
    if (this.session) {
      try { this.session.close(); } catch { /* ignore */ }
      this.session = null;
    }

    // Brief pause before reconnect
    await new Promise(r => setTimeout(r, 500));

    if (this.active) {
      await this.initiateConnection();
    }
  }

  public async sendFrame(base64Image: string) {
    if (!this.session || !this.active) return;
    try {
      const cleanBase64 = base64Image.includes(',') ? base64Image.split(',')[1] : base64Image;

      // 使用 media 字段发送图片（支持 JPEG 和 PNG）
      // 注意：图片必须是有效的格式，否则会报错
      this.session.sendRealtimeInput({
        media: { mimeType: 'image/jpeg', data: cleanBase64 },
      });
    } catch (err) {
      console.error('Frame send error:', err);
    }
  }

  public disconnect() {
    this.active = false;
    this.stopSessionTimer();
    if (this.session) {
      try { this.session.close(); } catch { /* ignore */ }
      this.session = null;
    }
    this.resumptionHandle = undefined;
    this.reconnectCount = 0;
    this.config.onStateChange(ConnectionState.DISCONNECTED);
  }
}
