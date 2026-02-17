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
  private audioPrimed = false;
  private connecting = false;
  private url: string;

  constructor(cfg: QwenRealtimeConfig) {
    this.cfg = cfg;
    const port = (process.env as any).WS_PROXY_PORT || 3301;
    this.url = `ws://localhost:${port}/realtime`;
  }

  public async connect() {
    if (this.connecting || this.ws) return;
    this.connecting = true;
    this.cfg.onStateChange(ConnectionState.CONNECTING);
    try {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => {
        this.cfg.onStateChange(ConnectionState.CONNECTED);
        this.send({
          type: "session.update",
          session: {
            modalities: ["text"],
            instructions: WEPOKER_SYSTEM_PROMPT,
            turn_detection: null,
          },
        });
      };
      this.ws.onmessage = (evt) => {
        try {
          const ev = JSON.parse(typeof evt.data === "string" ? evt.data : "");
          const t = ev?.type;
          if (t === "response.text.delta" && ev.delta) {
            this.cfg.onTranscription(ev.delta);
          } else if (t === "response.done") {
            this.audioPrimed = false;
          }
        } catch {}
      };
      this.ws.onclose = () => {
        this.cfg.onStateChange(ConnectionState.DISCONNECTED);
        this.ws = null;
      };
      this.ws.onerror = (e: any) => {
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
    if (!this.audioPrimed) {
      const silent = new Uint8Array(3200);
      this.send({ type: "input_audio_buffer.append", audio: b64(silent) });
      this.audioPrimed = true;
    }
    const clean = base64Image.includes(",") ? base64Image.split(",")[1] : base64Image;
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
