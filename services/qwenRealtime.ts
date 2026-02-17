import { ConnectionState } from "../types";
declare const process: any;

interface QwenRealtimeConfig {
  onStateChange: (state: ConnectionState) => void;
  onTranscription: (text: string) => void;
  onError: (error: string) => void;
}

const WEPOKER_SYSTEM_PROMPT = `
ROLE: WePoker 实时GTO分析专家 (中文界面识别 + 英文标准输出)
CONTEXT:
你正在观看 WePoker (微扑克) 的实时画面流。
OBJECTIVE:
1. 识别手牌、公共牌、底池大小、各玩家筹码
2. 判断是否轮到玩家操作
3. 基于GTO策略给出最优决策
STRICT OUTPUT:
"FOLD"|"CHECK"|"CALL"|"RAISE [金额]"|"ALL-IN"|"WAITING"
`;

function b64(buf: Uint8Array) {
  let binary = "";
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  return btoa(binary);
}

export class QwenRealtimeService {
  private ws: WebSocket | null = null;
  private cfg: QwenRealtimeConfig;
  private connecting = false;
  private url: string;

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
            this.cfg.onTranscription(ev.delta);
          } else if (t === "response.done") {
            // response cycle complete
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
                turn_detection: null, // 关闭 VAD，使用手动 commit + response.create
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
    // 发送静音 audio（API 要求至少一次 audio 在 image 之前）
    const silent = new Uint8Array(3200);
    this.send({ type: "input_audio_buffer.append", audio: b64(silent) });
    // 发送图片帧
    this.send({ type: "input_image_buffer.append", image: clean });
    // 手动 commit + 触发响应（需要 turn_detection: null）
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
