import { ConnectionState } from "../types";
import { getAnalyzeHttpUrl } from "./proxyUrl";

interface QwenStreamConfig {
  onStateChange: (state: ConnectionState) => void;
  onTranscription: (text: string) => void;
  onDelta: (text: string) => void;
  onResponseDone: () => void;
  onError: (error: string, isNetworkError?: boolean) => void;
}

const SYSTEM_PROMPT = `你是德州扑克GTO助手。分析WePoker手机截图，给出行动建议。

## 判断规则（按优先级）

### 规则1：看到操作按钮 = 轮到我 → 必须给建议
WePoker操作按钮长这样（出现在屏幕底部）：
- 红色圆形"弃牌"按钮
- 蓝色圆形"跟注"按钮（上面有金额数字）
- 蓝色椭圆"加注"按钮
- "让牌"按钮 / "allin"按钮
- 底池比例按钮行（底池1/3, 1/2, 2/3, 1等灰色圆形按钮）
- 加注滑动条

⚠️ 只要看到上述任何一个 → 轮到我了 → 输出ACTION建议，绝对不能输出WAITING！

### 规则2：没有操作按钮 = 不是我的回合
屏幕底部只显示手牌、没有可点击按钮 → ACTION: WAITING

### 规则3：不是牌桌
大厅/菜单/结算 → ACTION: SKIP

## 输出格式

轮到我时，严格按此格式（第一行必须是ACTION）：
ACTION: [FOLD/CALL/CHECK/RAISE/ALLIN]
手牌: [底牌]
公共牌: [公共牌或"无"]
底池: [金额]
阶段: [翻牌前/翻牌/转牌/河牌]
分析: [一句话理由]

不是我的回合时：
ACTION: WAITING
手牌: [底牌]
公共牌: [公共牌或"无"]
底池: [金额]
阶段: [阶段]

## GTO策略

**翻牌前：**
- AA/KK/QQ/AKs/AKo → RAISE
- JJ/TT/AQs/AQo/AJs/KQs → RAISE或CALL
- 小对子(22-99)/同花连牌(76s-JTs)/Axs → CALL（看赔率）
- 垃圾牌(72o/83o/J2o等) → FOLD
- 有人大额加注，手牌不强 → FOLD

**翻牌后：**
- 顶对好踢脚+/两对+/三条+ → RAISE
- 中对/弱顶对 → CHECK或CALL
- 强听牌(两头顺/同花听) → RAISE或CALL
- 没中没听牌 → CHECK或FOLD
- 对手大额下注，赢率不够 → FOLD

**赔率：** 跟注赢率 = 跟注额/(底池+跟注额)，赢率够→CALL，不够→FOLD`;

export class QwenStreamService {
  private cfg: QwenStreamConfig;
  private proxyUrl: string;
  private abortCtrl: AbortController | null = null;
  private connected = false;

  constructor(cfg: QwenStreamConfig) {
    this.cfg = cfg;
    this.proxyUrl = getAnalyzeHttpUrl();
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
        console.log('[QwenStream] Full response:', responseBuffer.trim());
        this.cfg.onTranscription(responseBuffer.trim());
      } else {
        console.warn('[QwenStream] Empty response received');
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
