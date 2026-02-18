import { ConnectionState } from "../types";
declare const process: any;

interface QwenRealtimeConfig {
  onStateChange: (state: ConnectionState) => void;
  onTranscription: (text: string) => void; // 完整响应（response.done 后）
  onDelta: (text: string) => void;          // 流式 delta（实时显示 AI 在打字）
  onResponseDone: () => void;               // 通知 PokerHUD 发下一帧
  onError: (error: string) => void;
}

const WEPOKER_SYSTEM_PROMPT = `
你是 WePoker 实时GTO分析助手。每帧画面你必须：

## 界面识别
- 屏幕最下方的玩家 = Hero（我）
- Hero手牌：头像旁2张牌的点数+花色（如 Ah Kd, 7s 2c）
- 公共牌：牌桌中央横排 0-5 张牌
- 底池：牌桌中上方数字
- 庄位：带"D"标记的玩家
- 盲注：SB(小盲)/BB(大盲)位的筹码数字
- 需跟注金额：底部操作按钮旁的数字
- 是否我的回合：底部操作按钮是否亮起（弃牌/过牌/跟注/加注/全压）
- 弃牌玩家：显示"弃牌"字样的头像

## 计算
- 赔率% = 跟注额 / (底池 + 跟注额) × 100
- SPR = Hero筹码 / 底池
- 位置：相对庄位D，依次为 BTN/CO/HJ/MP/UTG/SB/BB

## 严格输出格式（必须按此格式，每项一行）
ACTION: [FOLD|CHECK|CALL|RAISE 金额|ALL-IN|WAITING]
手牌: [如 Ah Kd 或 未知]
公共牌: [如 Ks 7h 2c 或 无]
阶段: [翻牌前|翻牌|转牌|河牌]
位置: [BTN/CO/HJ/MP/UTG/SB/BB]
底池: [数字]
跟注: [数字或0]
赔率: [xx.x%或-]
SPR: [数字或-]
分析: [2-4句详细分析：手牌强度、位置优势、赔率是否合算、对手范围判断、建议理由]

## 输出示例
ACTION: RAISE 120
手牌: Ah Kd
公共牌: Ks 7h 2c
阶段: 翻牌
位置: BTN
底池: 80
跟注: 0
赔率: -
SPR: 18.5
分析: 翻牌拿到顶对顶踢(TPTK)，K72彩虹面干燥无顺无花。BTN位有位置优势，对手范围宽。标准3/4底池价值下注60，既能从KJ/KT/KQ获得价值，也能让A高弃牌。

ACTION: WAITING
手牌: 未知
公共牌: 无
阶段: 翻牌前
位置: BB
底池: 60
跟注: 0
赔率: -
SPR: -
分析: 当前不是我的回合，等待其他玩家行动。
`;


export class QwenRealtimeService {
  private ws: WebSocket | null = null;
  private cfg: QwenRealtimeConfig;
  private connecting = false;
  private url: string;
  private responseBuffer = "";

  constructor(cfg: QwenRealtimeConfig) {
    this.cfg = cfg;
    const port = (process.env as any).WS_PROXY_PORT || '3301';
    this.url = `ws://localhost:${port}/realtime`;
    console.log('[QwenRealtime] URL:', this.url);
  }

  public async connect() {
    if (this.connecting || this.ws) return;
    this.connecting = true;
    this.cfg.onStateChange(ConnectionState.CONNECTING);
    try {
      console.log('[QwenRealtime] Connecting to', this.url);
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => {
        console.log('[QwenRealtime] WebSocket opened (waiting for session.created before sending update)');
        this.cfg.onStateChange(ConnectionState.CONNECTING);
      };
      this.ws.onmessage = (evt) => {
        try {
          const ev = JSON.parse(typeof evt.data === "string" ? evt.data : "");
          const t = ev?.type;
          if ((t === "response.text.delta" || t === "response.audio_transcript.delta") && ev.delta) {
            this.responseBuffer += ev.delta;
            // 实时流式回调，让 UI 显示 AI 正在打字
            this.cfg.onDelta(ev.delta);
          } else if (t === "response.done") {
            // 发送完整累积文本用于结构化解析
            if (this.responseBuffer.trim()) {
              this.cfg.onTranscription(this.responseBuffer.trim());
            }
            this.responseBuffer = "";
            // 通知 PokerHUD 可以发下一帧了
            this.cfg.onResponseDone();
          } else if (t === "error") {
            const errMsg = ev.error?.message || ev.error?.code || JSON.stringify(ev.error);
            console.error('[QwenRealtime] Server error event:', JSON.stringify(ev));
            this.cfg.onError(`服务端错误: ${errMsg}`);
          } else if (t === "session.created") {
            // upstream 已就绪，现在安全地发送 session.update
            console.log('[QwenRealtime] Session created, sending session.update');
            this.send({
              type: "session.update",
              session: {
                modalities: ["text", "audio"],
                instructions: WEPOKER_SYSTEM_PROMPT,
                turn_detection: null,
              },
            });
          } else if (t === "session.updated") {
            console.log('[QwenRealtime] Session updated successfully');
            this.cfg.onStateChange(ConnectionState.CONNECTED);
          }
        } catch (parseErr) {
          console.warn('[QwenRealtime] Failed to parse message:', parseErr);
        }
      };
      this.ws.onclose = (ev) => {
        const closeMessages: Record<number, string> = {
          1000: '正常关闭',
          1001: '端点离开',
          1005: '正常关闭',
          1006: '异常关闭（未收到 close frame）',
          1008: '策略违规（可能触发内容过滤）',
          1011: '服务端内部错误',
          1013: '服务器繁忙',
        };
        const normalCodes = [1000, 1001, 1005];
        const desc = closeMessages[ev.code] || `未知错误 (${ev.code})`;
        console.log(`[QwenRealtime] WebSocket closed: ${ev.code} - ${desc}`, ev.reason || '');
        if (!normalCodes.includes(ev.code)) {
          this.cfg.onError(`连接关闭: ${desc}`);
        }
        this.cfg.onStateChange(ConnectionState.DISCONNECTED);
        this.ws = null;
      };
      this.ws.onerror = (e: any) => {
        console.error('[QwenRealtime] WebSocket error:', e?.message || e);
        this.cfg.onError("Realtime 连接失败");
        this.cfg.onStateChange(ConnectionState.ERROR);
      };
    } finally {
      this.connecting = false;
    }
  }

  private send(obj: any) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const event = { event_id: "event_" + Date.now(), ...obj };
    this.ws.send(JSON.stringify(event));
  }

  public async sendFrame(base64Image: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const clean = base64Image.includes(",") ? base64Image.split(",")[1] : base64Image;
    // Qwen Omni Realtime 必须有 audio，否则不触发响应
    // 8000 bytes ≈ 167ms 静音 (24kHz 16-bit mono PCM)，满足最小要求
    const silent = new Uint8Array(8000);
    let binary = "";
    for (let i = 0; i < silent.length; i++) binary += String.fromCharCode(silent[i]);
    const silentB64 = btoa(binary);
    this.send({ type: "input_audio_buffer.append", audio: silentB64 });
    this.send({ type: "input_image_buffer.append", image: clean });
    this.send({ type: "input_audio_buffer.commit" });
    this.send({ type: "response.create" });
  }

  public disconnect() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.cfg.onStateChange(ConnectionState.DISCONNECTED);
  }
}
