/**
 * Pure functions for parsing AI poker analysis responses.
 * These are extracted from PokerHUD so they can be unit tested independently.
 */

export type AdviceType = 'NEUTRAL' | 'ACTION' | 'FOLD' | 'GOOD' | 'WARNING' | 'READY' | 'SKIP';

export interface AnalysisData {
  hand: string;
  board: string;
  stage: string;
  position: string;
  pot: string;
  callAmt: string;
  odds: string;
  spr: string;
  detail: string;
  confidence: 'high' | 'medium' | 'low';
  confidenceIssue?: string;
}

export interface ParsedResponse {
  display: string;
  type: AdviceType;
  analysis: AnalysisData | null;
}

/** Known field labels — used to stop extraction at the next field boundary */
const FIELD_LABELS = ['ACTION', '预判', '预判加注额', '加注额', '手牌', '公共牌', '底池', '阶段', '分析', '位置', '跟注', '赔率', 'SPR'];

/**
 * Parse card rank from a card string (e.g. "A♠" -> "A", "10♦" -> "T")
 */
function parseCardRank(card: string): string {
  const match = card.trim().match(/^([2-9]|10|T|[JQKA])/i);
  if (!match) return '';
  const rank = match[1].toUpperCase();
  return rank === '10' ? 'T' : rank;
}

/**
 * Extract all card ranks from a hand or board string
 * e.g. "A♥ 8♥" -> ['A', '8'], "5♠ 6♦ Q♣" -> ['5', '6', 'Q']
 */
function extractRanks(cardsStr: string): string[] {
  if (!cardsStr || cardsStr === '无' || cardsStr === '-') return [];
  const cards = cardsStr.split(/\s+/);
  return cards.map(parseCardRank).filter(r => r !== '');
}

/**
 * Check if the analysis description is consistent with the actual hand and board
 * Returns confidence level and optional issue description
 */
function validateAnalysisConsistency(hand: string, board: string, detail: string): { confidence: 'high' | 'medium' | 'low', issue?: string } {
  if (!detail) return { confidence: 'medium' };

  const handRanks = extractRanks(hand);
  const boardRanks = extractRanks(board);
  const allRanks = [...handRanks, ...boardRanks];
  const detailLower = detail.toLowerCase();

  // 检查"顶对X"类描述
  const topPairMatch = detail.match(/顶对([AKQJT2-9])/i) || detail.match(/顶对\s*([AKQJT2-9])/i);
  if (topPairMatch) {
    const claimedRank = topPairMatch[1].toUpperCase();
    // 顶对需要手牌中有这张牌，且公共牌也有这张牌
    if (!handRanks.includes(claimedRank)) {
      return {
        confidence: 'low',
        issue: `分析提到"顶对${claimedRank}"，但手牌${hand}中没有${claimedRank}，可能是识别错误`
      };
    }
    if (!boardRanks.includes(claimedRank)) {
      return {
        confidence: 'low',
        issue: `分析提到"顶对${claimedRank}"，但公共牌${board}中没有${claimedRank}`
      };
    }
  }

  // 检查"对X"类描述（非顶对）
  const pairMatch = detail.match(/对([AKQJT2-9])/i);
  if (pairMatch && !topPairMatch) {
    const claimedRank = pairMatch[1].toUpperCase();
    if (!handRanks.includes(claimedRank) && !boardRanks.includes(claimedRank)) {
      return {
        confidence: 'low',
        issue: `分析提到"对${claimedRank}"，但手牌和公共牌中都没有${claimedRank}`
      };
    }
  }

  // 检查"两对"描述
  if (detail.includes('两对') || detail.includes('两對')) {
    // 两对需要至少有两对相同的牌
    const rankCounts = new Map<string, number>();
    for (const rank of allRanks) {
      rankCounts.set(rank, (rankCounts.get(rank) || 0) + 1);
    }
    const pairs = Array.from(rankCounts.entries()).filter(([_, count]) => count >= 2);
    if (pairs.length < 2) {
      return {
        confidence: 'low',
        issue: `分析提到"两对"，但实际手牌${hand}和公共牌${board}无法组成两对`
      };
    }
  }

  // 检查"三条"描述
  if (detail.includes('三条') || detail.includes('三條')) {
    const rankCounts = new Map<string, number>();
    for (const rank of allRanks) {
      rankCounts.set(rank, (rankCounts.get(rank) || 0) + 1);
    }
    const hasThreeOfAKind = Array.from(rankCounts.values()).some(count => count >= 3);
    if (!hasThreeOfAKind) {
      return {
        confidence: 'low',
        issue: `分析提到"三条"，但实际无法组成三条`
      };
    }
  }

  // 检查"顺子"描述
  if (detail.includes('顺子') || detail.includes('順子')) {
    // 简化检查：看是否有5张连续的牌
    const uniqueRanks = [...new Set(allRanks)].sort();
    if (uniqueRanks.length < 5) {
      return {
        confidence: 'low',
        issue: `分析提到"顺子"，但牌张数不足`
      };
    }
  }

  // 检查手牌是否与公共牌重复（明显错误）
  for (const rank of handRanks) {
    if (boardRanks.includes(rank)) {
      // 这种情况理论上不应该发生（一副牌只有4张同点数），除非AI看错了
      return {
        confidence: 'low',
        issue: `手牌${hand}和公共牌${board}都有${rank}，识别可能有误（一副牌只有4张${rank}）`
      };
    }
  }

  // 检查手牌数量
  if (handRanks.length !== 2 && handRanks.length !== 0) {
    return {
      confidence: 'low',
      issue: `识别到手牌数量${handRanks.length}张，但应该恰好2张`
    };
  }

  return { confidence: 'high' };
}

/** Extract a labeled field from structured AI output, e.g. "手牌: Ah Kd" */
export function extractField(text: string, key: string): string {
  // Build a boundary pattern that stops at the next known field label (on same line)
  const others = FIELD_LABELS.filter(l => l !== key).join('|');
  const re = new RegExp(`${key}[:：]\\s*(.+?)(?=\\s+(?:${others})[:：]|$)`, 'm');
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

/** Determine action type and display string from raw text */
export function detectAction(raw: string, fullText: string, raiseAmt?: string): { display: string; type: AdviceType } {
  const up = raw.toUpperCase();

  if (up.includes("ALL-IN") || up.includes("ALLIN") || raw.includes("全压")) {
    return { type: 'ACTION', display: '全压 ALL-IN' };
  }
  if (up.includes("RAISE") || up.includes("BET") || raw.includes("加注")) {
    // 优先使用结构化的加注额字段
    if (raiseAmt) {
      // 提取数字部分用于大字显示，如 "底池2/3=200" → "加注 200"
      const numMatch = raiseAmt.match(/=\s*(\d+)/);
      const amount = numMatch ? numMatch[1] : raiseAmt.match(/(\d+)/)?.[1];
      if (amount) return { type: 'ACTION', display: `加注 ${amount}` };
    }
    const m = raw.match(/(?:RAISE|BET|加注)\s*(\d+)/i) || fullText.match(/(?:RAISE|BET|加注)\s*(\d+)/i);
    if (m) return { type: 'ACTION', display: `加注 ${m[1]}` };
    // 兜底：从底池字段估算加注额（底池 2/3）
    const potMatch = fullText.match(/底池[:：]\s*(\d+)/);
    if (potMatch) {
      const potVal = parseInt(potMatch[1], 10);
      const raiseVal = Math.round(potVal * 2 / 3);
      return { type: 'ACTION', display: `加注 ${raiseVal}` };
    }
    return { type: 'ACTION', display: '加注 RAISE' };
  }
  if (up.includes("CALL") || raw.includes("跟注")) {
    return { type: 'GOOD', display: '跟注 CALL' };
  }
  if (up.includes("CHECK") || raw.includes("过牌")) {
    return { type: 'GOOD', display: '过牌 CHECK' };
  }
  if (up.includes("FOLD") || raw.includes("弃牌")) {
    // FOLD 建议：最高优先级，不再会被后续响应改变
    return { type: 'FOLD', display: '弃牌 FOLD' };
  }
  if (up.includes("READY") || raw.includes("准备") || raw.includes("即将")) {
    // READY 状态：即将轮到Hero，提前给出建议
    // 从 fullText 中提取具体建议（RAISE/CALL/FOLD 等）
    const readyAction = fullText.match(/建议(加注|跟注|弃牌|过牌|全压)/)
      || fullText.match(/应(FOLD|CALL|RAISE|CHECK|弃牌|跟注|加注|过牌)/i)
      || fullText.match(/则(FOLD|CALL|RAISE|弃牌|跟注|加注)/i)
      || fullText.match(/必须(弃牌|跟注|加注|过牌)/);
    let hint = '准备行动';
    if (readyAction) {
      const action = readyAction[1].toUpperCase();
      if (action === 'FOLD' || action === '弃牌') hint = '预判: 弃牌';
      else if (action === 'CALL' || action === '跟注') hint = '预判: 跟注';
      else if (action.includes('RAISE') || action === '加注') hint = '预判: 加注';
      else if (action === 'CHECK' || action === '过牌') hint = '预判: 过牌';
      else hint = '预判: ' + readyAction[1];
    }
    return { type: 'READY', display: hint };
  }
  if (up.includes("WAIT") || raw.includes("等待")) {
    return { type: 'NEUTRAL', display: '非本人轮次' };
  }
  if (up.includes("SKIP")) {
    return { type: 'SKIP', display: '' };
  }
  return { type: 'WARNING', display: raw.slice(0, 20) + (raw.length > 20 ? '...' : '') };
}

/**
 * Check if the text clearly recommends FOLD as the final action
 */
function isFoldRecommended(text: string): boolean {
  // 结尾明确说弃牌
  if (/最终(选择)?弃牌|结论[：:]?\s*弃牌|综上.*弃牌/.test(text)) return true;
  // 各种建议弃牌的表述
  if (/应(该)?弃牌|选择弃牌|建议弃牌|必须弃牌|果断弃牌|直接弃牌|只能弃牌|只能选择弃牌/.test(text)) return true;
  // 简短的"弃牌"结论（通常是最后几个字）
  if (/[\。，]\s*弃牌\s*[。\n]?$/m.test(text)) return true;
  return false;
}

/**
 * Extract the recommended action from analysis text
 * Returns: 'FOLD' | 'CALL' | 'CHECK' | 'RAISE' | 'ALLIN' | null
 */
function extractRecommendedAction(text: string): string | null {
  // 优先检查明确的结论性语句
  const conclusionPatterns = [
    /(?:建议|应|选择|最优|应当|应该)(全压|ALL[-]?IN)/i,
    /(?:建议|应|选择|最优|应当|应该)(加注|RAISE|BET)/i,
    /(?:建议|应|选择|最优|应当|应该)(跟注|CALL)/i,
    /(?:建议|应|选择|最优|应当|应该)(过牌|CHECK)/i,
    /(?:建议|应|选择|最优|应当|应该)(弃牌|FOLD)/i,
    /(?:结论|最终|综上).{0,5}(全压|加注|跟注|过牌|弃牌)/,
  ];

  for (const pattern of conclusionPatterns) {
    const match = text.match(pattern);
    if (match) {
      const action = match[1].toUpperCase();
      if (action === 'ALLIN' || action === '全压') return 'ALLIN';
      if (action === 'RAISE' || action === 'BET' || action === '加注') return 'RAISE';
      if (action === 'CALL' || action === '跟注') return 'CALL';
      if (action === 'CHECK' || action === '过牌') return 'CHECK';
      if (action === 'FOLD' || action === '弃牌') return 'FOLD';
    }
  }
  return null;
}

/**
 * Consistency check: if ACTION contradicts the analysis detail, trust the analysis.
 * e.g. ACTION=RAISE but analysis says "应弃牌" → override to FOLD
 * NOTE: FOLD is stable - once FOLD, always FOLD (won't be corrected to RAISE/CALL)
 */
function fixContradiction(result: { display: string; type: AdviceType }, detail: string, fullText: string, raiseAmt?: string): { display: string; type: AdviceType } {
  if (!detail) return result;

  // FOLD 建议：保持稳定，不被修正
  if (result.type === 'FOLD') {
    return result;
  }

  // 从分析中提取建议的行动
  const recommendedAction = extractRecommendedAction(detail) || extractRecommendedAction(fullText);

  if (recommendedAction) {
    // 如果分析建议 FOLD，覆盖任何其他行动
    if (recommendedAction === 'FOLD') {
      return { type: 'FOLD', display: '弃牌 FOLD' };
    }

    // 如果分析与当前结果不一致，以分析为准
    const currentIsAction = result.type === 'ACTION'; // RAISE/BET/ALLIN
    const currentIsGood = result.type === 'GOOD'; // CALL/CHECK

    if (recommendedAction === 'CALL' && currentIsAction) {
      return { type: 'GOOD', display: '跟注 CALL' };
    }
    if (recommendedAction === 'CHECK' && currentIsAction) {
      return { type: 'GOOD', display: '过牌 CHECK' };
    }
    if (recommendedAction === 'ALLIN' && currentIsGood) {
      return { type: 'ACTION', display: '全压 ALL-IN' };
    }
    if (recommendedAction === 'RAISE' && currentIsGood) {
      // 从 raiseAmt 或底池估算加注额
      if (raiseAmt) {
        const numMatch = raiseAmt.match(/=\s*(\d+)/);
        const amount = numMatch ? numMatch[1] : raiseAmt.match(/(\d+)/)?.[1];
        if (amount) return { type: 'ACTION', display: `加注 ${amount}` };
      }
      const potMatch = fullText.match(/底池[:：]\s*(\d+)/);
      if (potMatch) {
        const potVal = parseInt(potMatch[1], 10);
        const raiseVal = Math.round(potVal * 2 / 3);
        return { type: 'ACTION', display: `加注 ${raiseVal}` };
      }
      return { type: 'ACTION', display: '加注 RAISE' };
    }
  }

  // 旧的 FOLD 检查作为后备
  if (result.type === 'ACTION' || result.type === 'GOOD') {
    if (isFoldRecommended(detail) || isFoldRecommended(fullText)) {
      return { type: 'FOLD', display: '弃牌 FOLD' };
    }
  }

  return result;
}

/** Full parser: structured fields + action detection with multi-layer fallback */
export function parsePokerResponse(text: string): ParsedResponse {
  if (!text.trim()) {
    return { display: '非本人轮次', type: 'NEUTRAL', analysis: null };
  }

  // ── 1. Extract structured fields ──────────────────────────────
  const hand     = extractField(text, '手牌');
  const board    = extractField(text, '公共牌');
  const stage    = extractField(text, '阶段');
  const position = extractField(text, '位置');
  const pot      = extractField(text, '底池');
  const callAmt  = extractField(text, '跟注');
  const odds     = extractField(text, '赔率');
  const spr      = extractField(text, 'SPR');
  const detail   = extractField(text, '分析');
  const raiseAmt = extractField(text, '加注额');
  const preRaiseAmt = extractField(text, '预判加注额');

  // ── 1b. Fallback: if no structured fields at all, use full text as detail ──
  const hasAnyField = !!(hand || board || stage || detail);
  let finalDetail = detail;
  if (!hasAnyField) {
    // No structured format — treat trimmed text as the detail for display
    finalDetail = text.trim();
  }

  // ── 1c. Validate consistency between hand/board and analysis ─────────────────
  const validation = validateAnalysisConsistency(hand, board, finalDetail);

  const hasStructuredData = !!(hand || board || stage || finalDetail);
  const analysis: AnalysisData | null = hasStructuredData
    ? { hand, board, stage, position, pot, callAmt, odds, spr, detail: finalDetail, confidence: validation.confidence, confidenceIssue: validation.issue }
    : null;

  // ── 2. Determine action ────────────────────────────────────────
  // Priority: ACTION: field(s) → first line → full-text scan
  // Check ALL ACTION: lines and use the first one with a valid action
  const actionMatches = text.matchAll(/ACTION[:：]\s*(.+)/gi);
  for (const m of actionMatches) {
    const result = detectAction(m[1].trim(), text, raiseAmt);
    if (result.type === 'NEUTRAL') {
      // WAITING — check for 预判 field to upgrade to READY
      const preAction = extractField(text, '预判');
      if (preAction) {
        const preResult = detectAction(preAction, text, preRaiseAmt);
        if (preResult.type !== 'WARNING' && preResult.type !== 'NEUTRAL') {
          return { display: '预判: ' + preResult.display, type: 'READY', analysis };
        }
      }
      return { ...result, analysis };
    }
    if (result.type !== 'WARNING') {
      const fixed = fixContradiction(result, finalDetail, text, raiseAmt);
      if (fixed !== result) console.log('⚠️ 一致性校正:', result.display, '→', fixed.display);
      return { ...fixed, analysis };
    }
  }

  const firstLine = text.split('\n')[0].trim();
  const firstLineResult = detectAction(firstLine, text, raiseAmt);
  if (firstLineResult.type !== 'WARNING') {
    const fixed = fixContradiction(firstLineResult, finalDetail, text, raiseAmt);
    return { ...fixed, analysis };
  }

  // Full-text fallback
  const fallbackResult = detectAction(text, text, raiseAmt);
  const fixedFallback = fixContradiction(fallbackResult, finalDetail, text, raiseAmt);
  return { ...fixedFallback, analysis };
}
