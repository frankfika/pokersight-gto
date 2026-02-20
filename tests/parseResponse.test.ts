import { describe, it, expect } from 'vitest';
import { parsePokerResponse, extractField, detectAction } from '../utils/parseResponse';

// ─────────────────────────────────────────────────────────────────────────────
// extractField
// ─────────────────────────────────────────────────────────────────────────────
describe('extractField', () => {
  it('extracts colon-separated Chinese field', () => {
    expect(extractField('手牌: Ah Kd', '手牌')).toBe('Ah Kd');
  });

  it('extracts field with full-width colon', () => {
    expect(extractField('手牌：Ah Kd', '手牌')).toBe('Ah Kd');
  });

  it('extracts field from multi-line text', () => {
    const text = 'ACTION: RAISE 120\n手牌: Qs Qd\n分析: 口袋Q超强牌';
    expect(extractField(text, 'ACTION')).toBe('RAISE 120');
    expect(extractField(text, '手牌')).toBe('Qs Qd');
    expect(extractField(text, '分析')).toBe('口袋Q超强牌');
  });

  it('returns empty string for missing field', () => {
    expect(extractField('ACTION: FOLD\n手牌: 72o', 'SPR')).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectAction
// ─────────────────────────────────────────────────────────────────────────────
describe('detectAction', () => {
  it('detects FOLD', () => {
    const r = detectAction('FOLD', '');
    expect(r.type).toBe('FOLD');
    expect(r.display).toContain('FOLD');
  });

  it('detects CHECK', () => {
    expect(detectAction('CHECK', '').type).toBe('GOOD');
  });

  it('detects CALL', () => {
    expect(detectAction('CALL', '').type).toBe('GOOD');
  });

  it('detects RAISE with amount', () => {
    const r = detectAction('RAISE 150', '');
    expect(r.type).toBe('ACTION');
    expect(r.display).toBe('加注 150');
  });

  it('detects ALL-IN', () => {
    const r = detectAction('ALL-IN', '');
    expect(r.type).toBe('ACTION');
    expect(r.display).toContain('ALL-IN');
  });

  it('detects ALLIN (no hyphen)', () => {
    expect(detectAction('ALLIN', '').type).toBe('ACTION');
  });

  it('detects WAITING', () => {
    expect(detectAction('WAITING', '').type).toBe('NEUTRAL');
  });

  it('detects Chinese 弃牌', () => {
    expect(detectAction('弃牌', '').type).toBe('FOLD');
  });

  it('detects Chinese 全压', () => {
    expect(detectAction('全压', '').type).toBe('ACTION');
  });

  it('falls back to amount from fullText if actionLine has no number', () => {
    const r = detectAction('RAISE', '建议加注 200 元');
    expect(r.display).toBe('加注 200');
  });

  it('returns WARNING for unrecognized action', () => {
    expect(detectAction('UNKNOWN TEXT', '').type).toBe('WARNING');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parsePokerResponse — standard structured format
// ─────────────────────────────────────────────────────────────────────────────
describe('parsePokerResponse — structured format', () => {
  const STANDARD_RAISE = [
    'ACTION: RAISE 120',
    '手牌: Ah Kd',
    '公共牌: Ks 7h 2c',
    '阶段: 翻牌',
    '位置: BTN',
    '底池: 80',
    '跟注: 0',
    '赔率: -',
    'SPR: 18.5',
    '分析: 翻牌拿到TPTK，牌面干燥，BTN位价值下注3/4底池。',
  ].join('\n');

  it('parses action correctly', () => {
    const r = parsePokerResponse(STANDARD_RAISE);
    expect(r.type).toBe('ACTION');
    expect(r.display).toBe('加注 120');
  });

  it('extracts all analysis fields', () => {
    const r = parsePokerResponse(STANDARD_RAISE);
    expect(r.analysis).not.toBeNull();
    expect(r.analysis!.hand).toBe('Ah Kd');
    expect(r.analysis!.board).toBe('Ks 7h 2c');
    expect(r.analysis!.stage).toBe('翻牌');
    expect(r.analysis!.position).toBe('BTN');
    expect(r.analysis!.pot).toBe('80');
    expect(r.analysis!.callAmt).toBe('0');
    expect(r.analysis!.odds).toBe('-');
    expect(r.analysis!.spr).toBe('18.5');
    expect(r.analysis!.detail).toContain('TPTK');
  });
});

describe('parsePokerResponse — FOLD', () => {
  const FOLD_TEXT = [
    'ACTION: FOLD',
    '手牌: 7s 2c',
    '公共牌: 无',
    '阶段: 翻牌前',
    '位置: UTG',
    '底池: 60',
    '跟注: 20',
    '赔率: 25.0%',
    'SPR: -',
    '分析: UTG位拿到72o，最差手牌，直接弃牌。',
  ].join('\n');

  it('detects FOLD action', () => {
    const r = parsePokerResponse(FOLD_TEXT);
    expect(r.type).toBe('FOLD');
    expect(r.display).toContain('FOLD');
  });

  it('extracts pot odds for FOLD', () => {
    const r = parsePokerResponse(FOLD_TEXT);
    expect(r.analysis!.odds).toBe('25.0%');
    expect(r.analysis!.callAmt).toBe('20');
  });
});

describe('parsePokerResponse — CHECK', () => {
  const CHECK_TEXT = [
    'ACTION: CHECK',
    '手牌: Ah 9d',
    '公共牌: Kh 7c 2d',
    '阶段: 翻牌',
    '位置: BB',
    '底池: 40',
    '跟注: 0',
    '赔率: -',
    'SPR: 12.0',
    '分析: BB位翻牌后没有对应这个牌面，没有跟注金额，选择过牌。',
  ].join('\n');

  it('detects CHECK action', () => {
    const r = parsePokerResponse(CHECK_TEXT);
    expect(r.type).toBe('GOOD');
    expect(r.display).toContain('CHECK');
  });
});

describe('parsePokerResponse — CALL', () => {
  const CALL_TEXT = [
    'ACTION: CALL',
    '手牌: Jh Td',
    '公共牌: 9s 8c 2h',
    '阶段: 翻牌',
    '位置: CO',
    '底池: 100',
    '跟注: 30',
    '赔率: 23.1%',
    'SPR: 8.5',
    '分析: 双头顺子听牌，赔率合算，跟注。',
  ].join('\n');

  it('detects CALL action', () => {
    const r = parsePokerResponse(CALL_TEXT);
    expect(r.type).toBe('GOOD');
    expect(r.display).toContain('CALL');
  });

  it('extracts pot odds for CALL', () => {
    const r = parsePokerResponse(CALL_TEXT);
    expect(r.analysis!.odds).toBe('23.1%');
  });
});

describe('parsePokerResponse — ALL-IN', () => {
  const ALLIN_TEXT = [
    'ACTION: ALL-IN',
    '手牌: As Ad',
    '公共牌: Ac Kh Qd',
    '阶段: 翻牌',
    '位置: SB',
    '底池: 200',
    '跟注: 0',
    '赔率: -',
    'SPR: 2.1',
    '分析: 顶暗三，牌面有顺子可能，SPR低适合全压保护。',
  ].join('\n');

  it('detects ALL-IN', () => {
    const r = parsePokerResponse(ALLIN_TEXT);
    expect(r.type).toBe('ACTION');
    expect(r.display).toContain('ALL-IN');
  });

  it('extracts low SPR', () => {
    expect(parsePokerResponse(ALLIN_TEXT).analysis!.spr).toBe('2.1');
  });
});

describe('parsePokerResponse — WAITING', () => {
  const WAITING_TEXT = [
    'ACTION: WAITING',
    '手牌: 未知',
    '公共牌: 无',
    '阶段: 翻牌前',
    '位置: BB',
    '底池: 60',
    '跟注: 0',
    '赔率: -',
    'SPR: -',
    '分析: 当前不是我的回合，等待中。',
  ].join('\n');

  it('detects WAITING', () => {
    const r = parsePokerResponse(WAITING_TEXT);
    expect(r.type).toBe('NEUTRAL');
    expect(r.display).toContain('非本人');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fallback: AI ignores format and outputs plain Chinese
// ─────────────────────────────────────────────────────────────────────────────
describe('parsePokerResponse — fallback: no structured format', () => {
  it('detects RAISE from plain Chinese text', () => {
    const r = parsePokerResponse('你应该加注200，手牌很强');
    expect(r.type).toBe('ACTION');
    expect(r.display).toBe('加注 200');
    // fallback: full text used as detail
    expect(r.analysis).not.toBeNull();
    expect(r.analysis!.detail).toBe('你应该加注200，手牌很强');
  });

  it('detects FOLD from plain Chinese text', () => {
    const r = parsePokerResponse('这手牌建议弃牌，太弱了');
    expect(r.type).toBe('FOLD');
  });

  it('detects CHECK from plain text', () => {
    const r = parsePokerResponse('CHECK is the best option here');
    expect(r.type).toBe('GOOD');
  });

  it('detects 全压 from Chinese', () => {
    const r = parsePokerResponse('建议全压，AA没必要怕');
    expect(r.type).toBe('ACTION');
    expect(r.display).toContain('ALL-IN');
  });

  it('detects WAITING when not hero turn', () => {
    const r = parsePokerResponse('等待其他玩家行动，尚未轮到我');
    expect(r.type).toBe('NEUTRAL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────
describe('parsePokerResponse — edge cases', () => {
  it('returns NEUTRAL for empty string', () => {
    const r = parsePokerResponse('');
    expect(r.type).toBe('NEUTRAL');
    expect(r.analysis).toBeNull();
  });

  it('returns NEUTRAL for whitespace-only string', () => {
    expect(parsePokerResponse('   \n  ').type).toBe('NEUTRAL');
  });

  it('handles RAISE without amount', () => {
    const r = parsePokerResponse('ACTION: RAISE\n手牌: AKo\n分析: 标准加注');
    expect(r.type).toBe('ACTION');
    expect(r.display).toContain('RAISE');
    expect(r.analysis!.hand).toBe('AKo');
  });

  it('prefers ACTION field over first-line keyword', () => {
    // First line says FOLD but ACTION field says CALL
    const r = parsePokerResponse('FOLD is wrong here\nACTION: CALL\n手牌: AQs\n分析: 强牌跟注');
    expect(r.type).toBe('GOOD');
    expect(r.display).toContain('CALL');
  });

  it('parses partial structured output (only some fields present)', () => {
    const r = parsePokerResponse('ACTION: CHECK\n手牌: 9s 8s\n分析: 听顺听花，先check');
    expect(r.type).toBe('GOOD');
    expect(r.analysis!.hand).toBe('9s 8s');
    expect(r.analysis!.board).toBe('');
    expect(r.analysis!.detail).toBe('听顺听花，先check');
  });

  it('free-form text without action creates analysis with detail', () => {
    const r = parsePokerResponse('这是一个非牌桌的画面，看起来是手机桌面');
    expect(r.type).toBe('WARNING');
    expect(r.analysis).not.toBeNull();
    expect(r.analysis!.detail).toBe('这是一个非牌桌的画面，看起来是手机桌面');
  });

  it('extracts amount when written as Chinese "加注 300"', () => {
    const r = parsePokerResponse('我方应该加注 300，位置和牌面都有利');
    expect(r.type).toBe('ACTION');
    expect(r.display).toBe('加注 300');
  });

  it('uses full text as detail when no structured fields present', () => {
    const r = parsePokerResponse('FOLD');
    expect(r.type).toBe('FOLD');
    // fallback: full text used as detail
    expect(r.analysis).not.toBeNull();
    expect(r.analysis!.detail).toBe('FOLD');
  });
});
