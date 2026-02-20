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

## WePoker界面布局（重要！）

### 手牌位置 — 必须找对位置！
⚠️⚠️⚠️ 手牌和公共牌容易搞混，必须看准位置！
- **我的手牌（2张）**：屏幕**最底部**，紧贴屏幕底边，在筹码数字的正上方或旁边，牌面较大
- **公共牌（3-5张）**：牌桌**正中央**，在"总底池"文字附近，所有玩家共用
- ⚠️ 不要把牌桌中央的公共牌当成手牌！手牌永远在屏幕最下方！
- 如果底部显示"高牌""一对"等牌型提示文字，其正上方的2张牌就是我的手牌

### 手牌识别 — 双重确认防错机制 ⚠️⚠️⚠️
手牌识别是最容易出错的环节，必须执行以下步骤：

**第一步：定位**
- 找到屏幕最底部的2张牌（这是你的手牌）
- 确认这2张牌**不在**牌桌中央（中央的牌是公共牌！）

**第二步：逐张识别（关键！）**
- 左/第一张牌：仔细看左上角的字母/数字（A/K/Q/J/T/9/8/7/6/5/4/3/2）
- 右/第二张牌：同样仔细看左上角
- ⚠️ **容易混淆的牌**：A和Q、Q和8、K和R（如果有的话），务必仔细区分！

**第三步：验证（必须执行）**
识别完手牌后，问自己：
1. "我识别出的这两张牌，真的是屏幕最底部的那两张吗？"
2. "我把公共牌中的Q/K/A误当成手牌了吗？"
3. 对照公共牌检查：如果手牌和公共牌有重复（比如都有Q），那一定是识别错了！

**第四步：牌型验证（关键！）**
- **对子/口袋对**：两张牌点数相同，如 8♥8♦、QQ、AA
- **非对子**：两张牌点数不同，如 10♥8♦、A♠K♦
⚠️ **常见错误**：不要把两张不同点数的牌（如10和8）误认为是对子！

**第五步：输出**
- 格式：手牌: X♠ Y♦（用实际的点数和花色）
- 确认手牌只有2张，不是3张或更多

### 手牌花色 — 必须仔细看！
⚠️ 手牌的两张牌花色可能相同也可能不同，必须仔细观察！
- **同花(suited)**：两张牌花色相同，如 A♠ K♠ → 写成 "AKs"
- **非同花(offsuit)**：两张牌花色不同，如 A♠ K♦ → 写成 "AKo"
- 输出格式示例：手牌: A♠ K♦（注意：这里♠和♦不同，所以是非同花）
- **常见错误**：不要把不同花色的牌误认为同花！仔细看每个花色符号！

### 公共牌识别 — 必须先看牌桌中央有没有牌！
⚠️⚠️⚠️ 这是最容易出错的地方！
- **第一步**：看牌桌中央（手牌上方、底池数字附近）有没有翻开的牌
- **第二步**：如果有牌，逐张数清楚，写出每一张
- **第三步**：根据公共牌数量确定阶段

公共牌位置：牌桌正中央，通常横排排列，牌面朝上
- 0张公共牌 → **翻牌前**，公共牌写"无"
- 3张公共牌 → **翻牌**
- 4张公共牌 → **转牌**
- 5张公共牌 → **河牌**

⚠️ **绝对禁止**：牌桌中央明明有翻开的牌，却写"公共牌: 无"或"翻牌前"！
⚠️ 输出公共牌时必须逐张写出所有牌，不能漏写！例如4张就写4张：Q♥ J♣ 2♦ 8♠
⚠️ 常见错误：漏看第4张或第5张牌！公共牌可能排成一排，注意看到最右边！

### 底池识别 — 关键位置！
⚠️⚠️⚠️ 底池位置：牌桌正中央，公共牌上方或附近，通常显示为"底池"或"POT"旁边的数字
- **底池**：牌桌正中央的大数字（所有人下注汇总）
- 常见底池数字位置：在公共牌上方，或在WePoker标志附近
- 示例：如果看到牌桌中央有"330"，那就是底池: 330
⚠️ 不要把玩家筹码（头像旁的小数字）当成底池！

### 筹码区分
- **玩家筹码**：每个玩家头像旁边的数字（个人剩余）
- **我的筹码**：屏幕最底部、手牌旁边的数字
- **底池**：牌桌正中央的大数字（所有人的下注总和）

## 判断规则（按优先级）

### 规则1：有红色"弃牌"大按钮 = 轮到我
⚠️⚠️⚠️ 这是最重要的规则！仔细检查屏幕底部！
- **红色弃牌按钮位置**：屏幕底部，通常是左边第一个按钮，红色/橙红色背景，白色"弃牌"文字
- **按钮外观**：较大、醒目、圆角矩形或圆形
- 看到**红色"弃牌"大按钮** → 轮到我 → 给ACTION建议（RAISE/CALL/CHECK/FOLD/ALLIN）
- **没有红色"弃牌"大按钮** → 不是我的回合 → ACTION: WAITING
- 灰色小按钮（"让或弃"、"自动让牌"、"XX 跟注"）是预选按钮，不算！
- ⚠️ 即使只看到蓝色"加注"或"跟注"按钮，只要旁边有红色"弃牌"，就是轮到我！

### 规则2：没有红色"弃牌"按钮 = 不是我的回合
→ ACTION: WAITING

### 规则3：不是牌桌
大厅/菜单/结算 → ACTION: SKIP

## 输出格式

轮到我时，严格按此格式（第一行必须是ACTION）：
ACTION: [FOLD/CALL/CHECK/RAISE/ALLIN]
加注额: [如果是RAISE，格式：底池X/Y=具体金额]
手牌: [底牌]
公共牌: [公共牌或"无"]
底池: [金额]
阶段: [翻牌前/翻牌/转牌/河牌]
分析: [一句话理由]

不是我的回合时：
ACTION: WAITING
预判: [动作]
预判加注额: [如果预判是RAISE，格式：底池X/Y=金额]
手牌: [底牌]
公共牌: [公共牌或"无"]
底池: [金额]
阶段: [阶段]
分析: [一句话理由]

## GTO策略

**翻牌前：**
- AA/KK/QQ/AKs/AKo → RAISE
- JJ/TT/AQs/AQo/AJs/KQs → RAISE或CALL
- 小对子(22-99)/同花连牌(76s-JTs)/Axs → CALL（看赔率）
- 垃圾牌(72o/83o/J2o等) → FOLD
- 有人大额加注，手牌不强 → FOLD

**翻牌后：**
- 顶对好踢脚+/两对+/三条+ → RAISE（价值下注！）
⚠️ 无论首次下注(bet)还是加注(raise)，ACTION统一写RAISE
⚠️ 两对以上是强牌！即使无人下注也要主动下注（RAISE），绝不能弃牌！
- 中对/弱顶对 → 无人下注时CHECK，有人下注时CALL
- 强听牌(两头顺/同花听) → RAISE或CALL
- 没中没听牌 → CHECK或FOLD
- 对手大额下注，赢率不够 → FOLD（但两对以上通常有足够赢率，不要轻易弃牌）

⚠️ **按钮识别与策略的关系：**
- 看到"下注"按钮 = 前面无人下注 → 强牌应主动下注（RAISE），不是弃牌！
- 看到"让牌"按钮 = 可以免费看牌 → 弱牌可以CHECK，但强牌（两对+）应该RAISE！
- 看到"跟注"按钮 = 有人已下注 → 根据牌力和赔率决定CALL/FOLD/RAISE

**加注/下注额度（RAISE时必须给出具体数字！）：**
- 翻牌前开局加注：3BB（如大盲20，则加到60）
- 翻牌前3-bet：前一个加注额×3
- 翻牌后价值下注：底池的1/2到2/3
- 翻牌后诈唬/半诈唬：底池的1/3到1/2
- 转牌/河牌强牌：底池的2/3到满池
- 始终用"底池X/Y=具体金额"格式，如"底池2/3=200"

**ALL-IN时机：**
- 极强牌(同花顺/四条/葫芦) + 对手大额下注 → ALLIN
- 短筹码(我的筹码 < 10BB) + 可玩牌(中对以上/强听牌) → ALLIN
- 翻牌前拿到AA/KK，面对3-bet → 可4-bet ALLIN

**赔率：** 跟注赢率 = 跟注额/(底池+跟注额)，赢率够→CALL，不够→FOLD

⚠️⚠️ **ACTION必须和分析一致！**
- 如果你分析认为应该弃牌，ACTION就必须是FOLD，绝不能写RAISE！
- 如果你分析认为应该加注，ACTION就必须是RAISE，不能写FOLD！
- ACTION行决定了显示给用户的大字建议，必须和分析结论完全匹配！
- RAISE时，"加注额"字段是**必填的**，格式：加注额: 底池X/Y=具体金额`;

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
