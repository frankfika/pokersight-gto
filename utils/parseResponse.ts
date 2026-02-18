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

/** Extract a labeled field from structured AI output, e.g. "手牌: Ah Kd" */
export function extractField(text: string, key: string): string {
  const m = text.match(new RegExp(`${key}[:：]\\s*(.+)`));
  return m ? m[1].trim() : "";
}

/** Determine action type and display string from raw text */
export function detectAction(raw: string, fullText: string): { display: string; type: AdviceType } {
  const up = raw.toUpperCase();

  if (up.includes("ALL-IN") || up.includes("ALLIN") || raw.includes("全压")) {
    return { type: 'ACTION', display: '全压 ALL-IN' };
  }
  if (up.includes("RAISE") || up.includes("BET") || raw.includes("加注")) {
    const m = raw.match(/(?:RAISE|BET|加注)\s*(\d+)/i) || fullText.match(/(?:RAISE|BET|加注)\s*(\d+)/i);
    return { type: 'ACTION', display: m ? `加注 ${m[1]}` : '加注 RAISE' };
  }
  if (up.includes("CALL") || raw.includes("跟注")) {
    return { type: 'GOOD', display: '跟注 CALL' };
  }
  if (up.includes("CHECK") || raw.includes("过牌")) {
    return { type: 'GOOD', display: '过牌 CHECK' };
  }
  if (up.includes("FOLD") || raw.includes("弃牌")) {
    return { type: 'FOLD', display: '弃牌 FOLD' };
  }
  if (up.includes("READY") || raw.includes("准备") || raw.includes("即将")) {
    // READY 状态：即将轮到Hero，提前给出建议
    // 从 fullText 中提取具体建议（RAISE/CALL/FOLD 等）
    const readyAction = fullText.match(/建议(加注|跟注|弃牌|过牌|全压)/);
    const hint = readyAction ? readyAction[1] : '准备行动';
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
  // Priority: ACTION: field → first line → full-text scan
  const actionFieldVal = extractField(text, 'ACTION');
  if (actionFieldVal) {
    return { ...detectAction(actionFieldVal, text), analysis };
  }

  const firstLine = text.split('\n')[0].trim();
  const firstLineResult = detectAction(firstLine, text);
  if (firstLineResult.type !== 'WARNING') {
    return { ...firstLineResult, analysis };
  }

  // Full-text fallback
  return { ...detectAction(text, text), analysis };
}
