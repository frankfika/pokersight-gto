/**
 * 诊断脚本：测试 Qwen Realtime API 连接
 * 分 3 个场景验证 session.update 是否触发 1011 错误
 *
 * 用法: node server/testConnection.js
 */

import WebSocket from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const MODEL = process.env.QWEN_REALTIME_MODEL || 'qwen3-omni-flash-realtime';
const REGION = process.env.DASHSCOPE_REGION || 'cn';
const BASE = REGION === 'intl' ? 'wss://dashscope-intl.aliyuncs.com' : 'wss://dashscope.aliyuncs.com';
const TARGET = `${BASE}/api-ws/v1/realtime?model=${encodeURIComponent(MODEL)}`;
const API_KEY = process.env.DASHSCOPE_API_KEY;

if (!API_KEY) {
  console.error('Missing DASHSCOPE_API_KEY in .env.local');
  process.exit(1);
}

const ORIGINAL_POKER_PROMPT = `
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

const NEUTRAL_PROMPT = '你是一个有用的助手，请用中文回答问题。';

const scenarios = [
  {
    name: '场景1: 无 instructions',
    session: { modalities: ['text', 'audio'] },
  },
  {
    name: '场景2: 中性 instructions',
    session: { modalities: ['text', 'audio'], instructions: NEUTRAL_PROMPT },
  },
  {
    name: '场景3: 原始 poker instructions',
    session: { modalities: ['text', 'audio'], instructions: ORIGINAL_POKER_PROMPT },
  },
];

function testScenario(scenario) {
  return new Promise((resolve) => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`开始测试: ${scenario.name}`);
    console.log(`${'='.repeat(60)}`);

    const ws = new WebSocket(TARGET, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    let sessionCreated = false;
    let sessionUpdated = false;
    const timeout = setTimeout(() => {
      console.log(`[${scenario.name}] ✅ 连接保持 5 秒未断开 — 通过`);
      ws.close();
      resolve({ name: scenario.name, result: 'PASS', detail: '连接保持稳定' });
    }, 5000);

    ws.on('open', () => {
      console.log(`[${scenario.name}] WebSocket 已连接`);
    });

    ws.on('message', (data) => {
      const text = data.toString();
      console.log(`[${scenario.name}] 收到:`, text.substring(0, 300));

      try {
        const ev = JSON.parse(text);

        if (ev.type === 'session.created') {
          sessionCreated = true;
          console.log(`[${scenario.name}] session.created 收到，发送 session.update...`);
          ws.send(JSON.stringify({
            event_id: 'evt_test_' + Date.now(),
            type: 'session.update',
            session: scenario.session,
          }));
        }

        if (ev.type === 'session.updated') {
          sessionUpdated = true;
          console.log(`[${scenario.name}] ✅ session.updated 收到 — 配置已接受`);
        }

        if (ev.type === 'error') {
          console.log(`[${scenario.name}] ❌ 收到 error 事件:`, JSON.stringify(ev, null, 2));
        }
      } catch {}
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      const reasonStr = reason.toString();
      console.log(`[${scenario.name}] WebSocket 关闭: code=${code}, reason=${reasonStr}`);

      if (code === 1011) {
        resolve({
          name: scenario.name,
          result: 'FAIL_1011',
          detail: `服务端内部错误 (1011): ${reasonStr}`,
        });
      } else {
        resolve({
          name: scenario.name,
          result: sessionUpdated ? 'PASS' : `CLOSED_${code}`,
          detail: `code=${code}, reason=${reasonStr}, sessionUpdated=${sessionUpdated}`,
        });
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      console.error(`[${scenario.name}] WebSocket 错误:`, err.message);
      resolve({ name: scenario.name, result: 'ERROR', detail: err.message });
    });
  });
}

async function main() {
  console.log('Qwen Realtime API 连接诊断');
  console.log(`目标: ${TARGET}`);
  console.log(`API Key: ${API_KEY.substring(0, 8)}...${API_KEY.substring(API_KEY.length - 4)}`);

  const results = [];
  for (const scenario of scenarios) {
    const result = await testScenario(scenario);
    results.push(result);
    // 场景间等待 1 秒
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('诊断结果汇总');
  console.log(`${'='.repeat(60)}`);
  for (const r of results) {
    const icon = r.result === 'PASS' ? '✅' : '❌';
    console.log(`${icon} ${r.name}: ${r.result} — ${r.detail}`);
  }

  const pokerFail = results[2]?.result === 'FAIL_1011';
  const neutralPass = results[1]?.result === 'PASS';
  const noInstrPass = results[0]?.result === 'PASS';

  console.log('\n--- 诊断结论 ---');
  if (pokerFail && (neutralPass || noInstrPass)) {
    console.log('🔴 确认: poker instructions 触发了内容安全过滤，导致 1011 错误');
    console.log('   建议: 改写 system prompt，避免使用敏感关键词');
  } else if (pokerFail && !neutralPass && !noInstrPass) {
    console.log('🟡 所有场景均失败，问题可能不是 instructions 内容导致');
    console.log('   建议: 检查 API 参数、model 名称、region 设置');
  } else {
    console.log('🟢 所有场景均通过，instructions 内容不是 1011 的原因');
    console.log('   建议: 检查 session.update 中的其他参数或网络问题');
  }
}

main().catch(console.error);
