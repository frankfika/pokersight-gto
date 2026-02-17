import { ConnectionState, SessionStatus } from "../types";
declare const process: any;

const SESSION_DURATION_SEC = 7200;

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

interface QwenVisionConfig {
  onStateChange: (state: ConnectionState) => void;
  onTranscription: (text: string) => void;
  onError: (error: string) => void;
  onSessionStatus?: (status: SessionStatus) => void;
}

export class QwenVisionService {
  private active = false;
  private config: QwenVisionConfig;
  private sessionTimer: ReturnType<typeof setInterval> | null = null;
  private remainingSeconds: number = SESSION_DURATION_SEC;
  private inFlight = false;

  constructor(config: QwenVisionConfig) {
    this.config = config;
  }

  public async connect() {
    this.active = true;
    this.config.onStateChange(ConnectionState.CONNECTING);
    this.config.onStateChange(ConnectionState.CONNECTED);
    this.startSessionTimer();
  }

  private startSessionTimer() {
    this.stopSessionTimer();
    this.remainingSeconds = SESSION_DURATION_SEC;
    this.emitSessionStatus();
    this.sessionTimer = setInterval(() => {
      this.remainingSeconds -= 1;
      this.emitSessionStatus();
      if (this.remainingSeconds <= 0 && this.active) {
        this.remainingSeconds = SESSION_DURATION_SEC;
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
      reconnectCount: 0,
    });
  }

  public async sendFrame(base64Image: string) {
    if (!this.active || this.inFlight) return;
    this.inFlight = true;
    try {
      const apiKey = (process.env as any).DASHSCOPE_API_KEY || (process.env as any).API_KEY;
      const url = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
      const image = base64Image.startsWith("data:") ? base64Image : `data:image/jpeg;base64,${base64Image}`;
      const body = {
        model: "qwen3-vl-plus",
        input: {
          messages: [
            {
              role: "system",
              content: [{ text: WEPOKER_SYSTEM_PROMPT }],
            },
            {
              role: "user",
              content: [{ image }, { text: "根据画面直接给出严格的决策输出" }],
            },
          ],
        },
        parameters: {
          result_format: "message",
          incremental_output: false,
        },
      };
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const msg = await resp.text();
        throw new Error(msg || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      const text =
        data?.output?.choices?.[0]?.message?.content?.[0]?.text ||
        data?.output?.text ||
        "";
      if (text) this.config.onTranscription(text);
    } catch (e: any) {
      this.config.onError(e?.message || "DashScope 调用失败");
      this.config.onStateChange(ConnectionState.ERROR);
    } finally {
      this.inFlight = false;
    }
  }

  public disconnect() {
    this.active = false;
    this.stopSessionTimer();
    this.config.onStateChange(ConnectionState.DISCONNECTED);
  }
}
