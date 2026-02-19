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
}

export interface ParsedResponse {
  display: string;
  type: AdviceType;
  analysis: AnalysisData | null;
}

/** Known field labels — used to stop extraction at the next field boundary */
const FIELD_LABELS = ['ACTION', '预判', '预判加注额', '加注额', '手牌', '公共牌', '底池', '阶段', '分析', '位置', '跟注', '赔率', 'SPR'];

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
    return { type: 'NEUTRAL', display: '等待中...' };
  }
  if (up.includes("SKIP")) {
    return { type: 'SKIP', display: '' };
  }
  return { type: 'WARNING', display: raw.slice(0, 20) + (raw.length > 20 ? '...' : '') };
}

/**
 * Consistency check: if ACTION contradicts the analysis detail, trust the analysis.
 * e.g. ACTION=RAISE but analysis says "应弃牌" → override to FOLD
 * NOTE: FOLD is stable - once FOLD, always FOLD (won't be corrected to RAISE/CALL)
 */
function fixContradiction(result: { display: string; type: AdviceType }, detail: string, fullText: string, raiseAmt?: string): { display: string; type: AdviceType } {
  if (!detail) return result;
  const d = detail;

  // FOLD 建议：保持稳定，不被修正
  if (result.type === 'FOLD') {
    return result;
  }

  // ACTION is aggressive (RAISE/CALL/CHECK) but analysis recommends FOLD
  if (result.type === 'ACTION' || result.type === 'GOOD') {
    if (/应(该)?弃牌|选择弃牌|建议弃牌|必须弃牌|果断弃牌|直接弃牌/.test(d)) {
      return { type: 'FOLD', display: '弃牌 FOLD' };
    }
  }

  return result;
}

/** Full parser: structured fields + action detection with multi-layer fallback */
export function parsePokerResponse(text: string): ParsedResponse {
  if (!text.trim()) {
    return { display: '等待中...', type: 'NEUTRAL', analysis: null };
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

  const hasStructuredData = !!(hand || board || stage || finalDetail);
  const analysis: AnalysisData | null = hasStructuredData
    ? { hand, board, stage, position, pot, callAmt, odds, spr, detail: finalDetail }
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
