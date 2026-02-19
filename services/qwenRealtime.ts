import { ConnectionState } from "../types";
declare const process: any;

interface QwenRealtimeConfig {
  onStateChange: (state: ConnectionState) => void;
  onTranscription: (text: string) => void;
  onDelta: (text: string) => void;
  onResponseDone: () => void;
  onError: (error: string, isNetworkError?: boolean) => void;
}

const SYSTEM_PROMPT = `你是德州扑克GTO助手。分析WePoker手机截图，给出行动建议。

## WePoker界面布局（重要！）

### 底池 vs 筹码 — 必须区分！
- **底池**：牌桌正中央的数字（所有人下注汇总）
- **玩家筹码**：每个玩家头像旁边的数字（个人剩余）
- **我的筹码**：屏幕最底部、手牌旁边的数字
⚠️ 底池只看牌桌中央的数字！不要把我的筹码当成底池！

### 判断是否轮到我 — 唯一标准：有没有红色"弃牌"大按钮
⚠️⚠️⚠️ 这是最重要的规则！
- 看到**红色大按钮写着"弃牌"** → 轮到我 → 给ACTION建议
- **没有红色"弃牌"大按钮** → 不是我的回合 → ACTION: WAITING
- 灰色小按钮（"让或弃"、"自动让牌"、"XX 跟注"）不算！那是预选按钮！

### 读按钮文字决定行动（仅在有红色弃牌按钮时）
- "跟注"+金额 → ACTION: CALL
- "下注" → ACTION: RAISE
- "让牌" → ACTION: CHECK
- "弃牌" → ACTION: FOLD
- "加注" → ACTION: RAISE
- "allin" → ACTION: ALLIN

### 底池比例按钮行
灰色圆形按钮（底池1/3, 1/2, 2/3, 1等）= 加注金额选项

## 判断规则

### 规则1：有红色"弃牌"大按钮 = 轮到我
⚠️ 只有看到红色"弃牌"才算轮到我！

### 规则2：没有红色"弃牌"按钮 = 不是我的回合
→ ACTION: WAITING

### 规则3：不是牌桌
大厅/菜单/结算 → ACTION: SKIP

## 输出格式 — 每个字段占一行，严格按照示例格式！

### 示例1：轮到我（有红色弃牌按钮）
ACTION: RAISE
加注额: 底池2/3=200
手牌: A♠ K♦
公共牌: Q♥ J♣ 2♦
底池: 300
阶段: 翻牌
分析: 顶对+强踢脚，价值下注

### 示例2：不是我的回合（无红色弃牌按钮）
ACTION: WAITING
预判: CALL
预判加注额:
手牌: 7♥ Q♦
公共牌: 5♦ 9♠ 4♣
底池: 605
阶段: 翻牌
分析: 中高牌无连接，跟注看转牌

### 示例3：非牌桌画面
ACTION: SKIP

⚠️ 绝对禁止：不能把多个字段写在同一行！每个字段必须换行！

## GTO策略

**翻牌前：**
- AA/KK/QQ/AKs/AKo → RAISE
- JJ/TT/AQs/AQo/AJs/KQs → RAISE或CALL
- 小对子(22-99)/同花连牌(76s-JTs)/Axs → CALL（看赔率）
- 垃圾牌(72o/83o/J2o等) → FOLD
- 有人大额加注，手牌不强 → FOLD

**翻牌后：**
- 顶对好踢脚+/两对+/三条+ → RAISE/BET
- 中对/弱顶对 → CHECK或CALL
- 强听牌(两头顺/同花听) → RAISE或CALL
- 没中没听牌 → CHECK或FOLD
- 对手大额下注，赢率不够 → FOLD

**加注/下注额度（RAISE/BET时必须给出具体数字！）：**
- 翻牌前开局加注：3BB（如大盲20，则加到60）
- 翻牌前3-bet：前一个加注额×3
- 翻牌后价值下注：底池的1/2到2/3
- 翻牌后诈唬/半诈唬：底池的1/3到1/2
- 转牌/河牌强牌：底池的2/3到满池
- 始终用"底池X/Y=具体金额"格式，如"底池2/3=200"

**赔率：** 跟注赢率 = 跟注额/(底池+跟注额)，赢率够→CALL，不够→FOLD

⚠️⚠️ **ACTION必须和分析一致！**
- 如果你分析认为应该弃牌，ACTION就必须是FOLD，绝不能写RAISE！
- 如果你分析认为应该加注，ACTION就必须是RAISE，不能写FOLD！
- ACTION行决定了显示给用户的大字建议，必须和分析结论完全匹配！
- RAISE/BET时，"加注额"字段是**必填的**，格式：加注额: 底池X/Y=具体金额`;

function b64(buf: Uint8Array) {
  let binary = "";
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  return btoa(binary);
}

/** 每次 response.create 附带的格式提醒（防止模型进入懒惰模式） */
const RESPONSE_INSTRUCTIONS = `务必按完整格式输出所有字段（每个字段单独一行）：
ACTION: (FOLD/CALL/RAISE/CHECK/WAITING/SKIP)
手牌: (如 A♠ K♦)
公共牌: (如 Q♥ J♣ 2♦ 或 无)
底池: (数字)
阶段: (翻牌前/翻牌/转牌/河牌)
分析: (简短理由)
如果是RAISE/BET还要输出 加注额: 底池X/Y=金额
如果是WAITING还要输出 预判: (动作)`;

export class QwenRealtimeService {
  private ws: WebSocket | null = null;
  private cfg: QwenRealtimeConfig;
  private connecting = false;
  private url: string;
  private responseBuffer = "";
  // 追踪会话历史 item IDs，用于清理旧消息防止模型复读
  private conversationItemIds: string[] = [];
  // 自动重连
  private shouldReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private static MAX_RECONNECT_ATTEMPTS = 5;

  constructor(cfg: QwenRealtimeConfig) {
    this.cfg = cfg;
    const port = (process.env as any).WS_PROXY_PORT || '3301';
    this.url = `ws://localhost:${port}/realtime`;
    console.log('[QwenRealtime] URL:', this.url);
  }

  public async connect() {
    if (this.connecting || this.ws) return;
    this.connecting = true;
    this.shouldReconnect = true;
    this.cfg.onStateChange(ConnectionState.CONNECTING);
    try {
      console.log('[QwenRealtime] Connecting to', this.url);
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => {
        console.log('[QwenRealtime] WebSocket opened (waiting for session.created)');
        this.cfg.onStateChange(ConnectionState.CONNECTING);
      };
      this.ws.onmessage = (evt) => {
        try {
          const ev = JSON.parse(typeof evt.data === "string" ? evt.data : "");
          const t = ev?.type;

          if (t === "response.text.delta" || t === "response.audio_transcript.delta") {
            if (ev.delta) {
              this.responseBuffer += ev.delta;
              this.cfg.onDelta(ev.delta);
            }
          } else if (t === "conversation.item.created") {
            // 追踪会话中的 item（用于后续清理）
            const itemId = ev.item?.id;
            if (itemId) this.conversationItemIds.push(itemId);
          } else if (t === "response.done") {
            // Response cycle complete — deliver full transcription
            if (this.responseBuffer.trim()) {
              console.log('[QwenRealtime] Full response:', this.responseBuffer.trim());
              this.cfg.onTranscription(this.responseBuffer.trim());
            } else {
              console.warn('[QwenRealtime] Empty response received');
            }
            this.responseBuffer = "";
            // 清理旧会话历史：保留最近 4 个 item（2轮对话），删除更早的
            this.pruneConversation();
            this.cfg.onResponseDone();
          } else if (t === "error") {
            const errMsg = ev.error?.message || ev.error?.code || JSON.stringify(ev.error);
            console.error('[QwenRealtime] Server error event:', JSON.stringify(ev));
            this.responseBuffer = "";
            this.cfg.onError(`服务端错误: ${errMsg}`, false);
            this.cfg.onResponseDone();
          } else if (t === "session.created") {
            console.log('[QwenRealtime] Session created, sending session.update');
            this.send({
              type: "session.update",
              session: {
                modalities: ["text"],
                instructions: SYSTEM_PROMPT,
                turn_detection: null,
              },
            });
          } else if (t === "session.updated") {
            console.log('[QwenRealtime] Session updated successfully');
            this.reconnectAttempts = 0; // 连接成功，重置重连计数
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
        this.ws = null;
        this.responseBuffer = "";

        // 异常关闭 → 自动重连
        if (!normalCodes.includes(ev.code) && this.shouldReconnect) {
          if (this.reconnectAttempts < QwenRealtimeService.MAX_RECONNECT_ATTEMPTS) {
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);
            this.reconnectAttempts++;
            console.log(`[QwenRealtime] 自动重连 ${this.reconnectAttempts}/${QwenRealtimeService.MAX_RECONNECT_ATTEMPTS}，${delay}ms 后重试...`);
            this.cfg.onStateChange(ConnectionState.CONNECTING);
            this.reconnectTimer = setTimeout(() => {
              this.connecting = false;
              this.connect();
            }, delay);
            return;
          }
          this.cfg.onError(`连接关闭: ${desc}（重连${QwenRealtimeService.MAX_RECONNECT_ATTEMPTS}次失败）`, true);
        } else if (!normalCodes.includes(ev.code)) {
          this.cfg.onError(`连接关闭: ${desc}`, true);
        }
        this.cfg.onStateChange(ConnectionState.DISCONNECTED);
      };
      this.ws.onerror = (e: any) => {
        console.error('[QwenRealtime] WebSocket error:', e?.message || e);
        this.cfg.onError("Realtime 连接失败", true);
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
    // Reset response buffer for new frame
    this.responseBuffer = "";
    // Send silent audio (API requires at least one audio before image)
    const silent = new Uint8Array(3200);
    this.send({ type: "input_audio_buffer.append", audio: b64(silent) });
    // Send image frame
    this.send({ type: "input_image_buffer.append", image: clean });
    // Manual commit + trigger response (requires turn_detection: null)
    this.send({ type: "input_audio_buffer.commit" });
    this.send({
      type: "response.create",
      response: {
        instructions: RESPONSE_INSTRUCTIONS,
        max_output_tokens: 300,
      },
    });
  }

  /** 清理旧会话历史，保留最近 4 个 item（约 2 轮），删除更早的 */
  private pruneConversation() {
    const KEEP = 4;
    if (this.conversationItemIds.length <= KEEP) return;
    const toDelete = this.conversationItemIds.splice(0, this.conversationItemIds.length - KEEP);
    for (const id of toDelete) {
      this.send({ type: "conversation.item.delete", item_id: id });
    }
    console.log(`[QwenRealtime] Pruned ${toDelete.length} old conversation items`);
  }

  public disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.responseBuffer = "";
    this.conversationItemIds = [];
    this.cfg.onStateChange(ConnectionState.DISCONNECTED);
  }
}
