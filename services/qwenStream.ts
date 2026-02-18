import { ConnectionState } from "../types";
declare const process: any;

interface QwenStreamConfig {
  onStateChange: (state: ConnectionState) => void;
  onTranscription: (text: string) => void;
  onDelta: (text: string) => void;
  onResponseDone: () => void;
  onError: (error: string, isNetworkError?: boolean) => void;
}

const SYSTEM_PROMPT = `
你是 WePoker 实时GTO分析助手。每帧画面你必须：

## 第一步：找到Hero（最重要！）
**Hero = 屏幕最下方/底部正中间的那个玩家，永远是我。**

## 第二步：判断谁在行动
**看倒计时：正在行动的玩家头像周围会有倒计时进度条（圆形或条形倒计时动画）。**

找到有倒计时的那个玩家：
- **倒计时在Hero头像上**（屏幕最底部的玩家）→ 轮到我！ACTION = 具体行动
- **倒计时在Hero前一个行动的玩家上**（即将轮到我）→ ACTION = READY
- **倒计时在其他玩家上** → ACTION = WAITING
- **底部出现操作按钮**（弃牌/过牌/跟注/加注/全压）→ 一定是轮到我！ACTION = 具体行动

## 界面布局
- 屏幕最下方正中 = Hero（我），只有Hero能看到自己的2张底牌
- 其他玩家按顺时针围坐在桌子周围
- 公共牌：牌桌中央横排 0-5 张牌
- 底池数字：牌桌中上方
- 庄位标记："D"
- 弃牌玩家：显示"弃牌"字样

## 计算
- 赔率% = 跟注额 / (底池 + 跟注额) × 100
- SPR = Hero筹码 / 底池
- 位置：相对庄位D，依次为 BTN/CO/HJ/MP/UTG/SB/BB

## 输出格式（根据状态不同！）

### 轮到Hero 或 READY：完整格式
ACTION: [FOLD|CHECK|CALL|RAISE 具体金额数字|ALL-IN|READY]
手牌: [Ah Kd]
公共牌: [Ks 7h 2c 或 无]
阶段: [翻牌前|翻牌|转牌|河牌]
位置: [BTN/CO/HJ/MP/UTG/SB/BB]
底池: [数字]
跟注: [数字或0]
赔率: [xx.x%或-]
SPR: [数字或-]
分析: [1-3句GTO分析]

### 不是Hero的回合：简略格式（不要给行动建议！）
ACTION: WAITING
分析: [1句简短描述当前牌局状况，例如"翻牌Ks7h2c，CO位玩家下注40，还剩2人待行动"]

## 非牌桌画面
如果画面**不是**扑克牌桌（例如手机桌面、聊天界面、其他应用），只输出一行：
ACTION: SKIP

## 重要规则
- 非牌桌画面只输出 ACTION: SKIP，不要输出任何其他内容
- WAITING 时**不要输出手牌、位置、赔率、SPR**，只要 ACTION 和分析两行
- RAISE 后面**必须跟具体数字**！例如 RAISE 120
- 加注金额 = 底池的 50%-100%，不确定就按 75%
- READY 时提前算好建议

## 输出示例

### 轮到Hero
ACTION: RAISE 120
手牌: Ah Kd
公共牌: Ks 7h 2c
阶段: 翻牌
位置: BTN
底池: 80
跟注: 0
赔率: -
SPR: 18.5
分析: TPTK在干燥面，标准3/4底池价值下注。

### 即将轮到Hero
ACTION: READY
手牌: Ah Kd
公共牌: Ks 7h 2c
阶段: 翻牌
位置: BTN
底池: 80
跟注: 40
赔率: 33.3%
SPR: 18.5
分析: 顶对顶踢在干面，如果对手下注建议加注到120。

### 不是Hero的回合
ACTION: WAITING
分析: 翻牌Ks7h2c，BTN位玩家下注40，CO位思考中。
`;

export class QwenStreamService {
  private cfg: QwenStreamConfig;
  private proxyUrl: string;
  private abortCtrl: AbortController | null = null;
  private connected = false;

  constructor(cfg: QwenStreamConfig) {
    this.cfg = cfg;
    const port = (process.env as any).WS_PROXY_PORT || '3301';
    this.proxyUrl = `http://localhost:${port}/api/analyze`;
  }

  public async connect() {
    this.connected = true;
    this.cfg.onStateChange(ConnectionState.CONNECTED);
  }

  public async sendFrame(base64Image: string) {
    if (!this.connected) return;

    // Cancel any in-flight request
    if (this.abortCtrl) {
      this.abortCtrl.abort();
    }
    this.abortCtrl = new AbortController();
    const { signal } = this.abortCtrl;

    const clean = base64Image.includes(",") ? base64Image.split(",")[1] : base64Image;
    let responseBuffer = "";

    try {
      const res = await fetch(this.proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: clean, systemPrompt: SYSTEM_PROMPT }),
        signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error('[QwenStream] API error:', res.status, errText);
        this.cfg.onError(`API 错误: ${res.status}`, false);
        // API error — keep the chain going
        this.cfg.onResponseDone();
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop()!; // keep incomplete line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              responseBuffer += delta;
              this.cfg.onDelta(delta);
            }
            if (chunk.error) {
              console.error('[QwenStream] SSE error:', chunk.error.message || JSON.stringify(chunk.error));
              this.cfg.onError(`API 错误: ${chunk.error.message || JSON.stringify(chunk.error)}`, false);
              this.cfg.onResponseDone();
              return;
            }
          } catch {
            // skip malformed SSE chunks
          }
        }
      }

      // Stream finished — deliver full response
      if (responseBuffer.trim()) {
        this.cfg.onTranscription(responseBuffer.trim());
      }
      this.cfg.onResponseDone();
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      console.error('[QwenStream] Network error:', err?.message || err);
      this.cfg.onError(`请求失败: ${err?.message || '网络错误'}`, true);
    }
  }

  public disconnect() {
    if (this.abortCtrl) {
      this.abortCtrl.abort();
      this.abortCtrl = null;
    }
    this.connected = false;
    this.cfg.onStateChange(ConnectionState.DISCONNECTED);
  }
}
