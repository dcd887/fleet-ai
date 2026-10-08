// scf_gateway.js — 《舰队协议 Fleet Protocol》腾讯云 SCF HTTP 决策网关（零依赖版）
// -----------------------------------------------------------------------------
// 部署目标：腾讯云 SCF（Web 函数 / HTTP 触发器）。纯 Node http，无需任何 npm 依赖。
// Godot 端以 HTTP 轮询调用：POST {网关}/decision，携带游戏状态，返回 AI 决策。
// 鉴权：请求头 x-gateway-key == SERVER_TOKEN（Godot 端 --ai-token 同名注入）。
// API key 只从环境变量读取，绝不写入代码/仓库，玩家 exe 内不含任何 key。
//
// 环境变量：
//   DASHSCOPE_API_KEY  必填（阿里云 DashScope，base 兼容 OpenAI 协议）
//   SERVER_TOKEN       建议必填（防刷，Godot --ai-token 与此一致）
//   AI_MODEL           可选，默认 qwen3.7-flash
//   DASHSCOPE_BASE_URL 可选，默认 https://dashscope.aliyuncs.com/compatible-mode/v1
//   LLM_TIMEOUT_MS     可选，默认 15000
//
// 本地测试（Windows，无需装任何包）：
//   set SERVER_TOKEN=dev123
//   node scf_gateway.js            -> 监听 9000
//   curl -X POST http://127.0.0.1:9000/decision -H "x-gateway-key: dev123" -H "Content-Type: application/json" -d "{\"player_fleet\":{}}"
// 腾讯云 SCF 部署：函数入口指向本文件导出（scf_handler 或默认 listen），或直接整文件粘贴进 Web 函数。
// -----------------------------------------------------------------------------
'use strict';

const http = require('http');
const crypto = require('crypto');

const API_KEY = process.env.DASHSCOPE_API_KEY || process.env.SILICONFLOW_API_KEY || '';
const BASE_URL = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const MODEL = process.env.AI_MODEL || 'qwen3.7-flash';
const SERVER_TOKEN = process.env.SERVER_TOKEN || '';
const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '8000', 10);
const PORT = parseInt(process.env.PORT || '9000', 10);

// 决策历史（全局，保持战术连贯；SCF 实例内有效）
let decisionHistory = [];

function sendJson(res, code, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Access-Control-Allow-Headers': 'Content-Type, x-gateway-key',
  }, extraHeaders || {}));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 2 * 1024 * 1024) { req.destroy(); resolve({}); return; } chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

// ---------------- Prompt 构建（与 bridge_server.py 对齐） ----------------
function buildPrompt(state) {
  const player = state.player_fleet || {};
  const enemies = state.enemy_fleets || {};
  const shipsPreview = JSON.stringify((player.ships || []).slice(0, 5));
  const enemiesPreview = JSON.stringify(enemies).slice(0, 800);
  const hist = JSON.stringify(decisionHistory.slice(-3));
  return `你是一个太空舰队指挥官，指挥多支敌方舰队。
当前战场状态：
【玩家舰队】
位置: ${JSON.stringify(player.avg_pos || [0, 0])}
总血量: ${player.total_hp || 0}
舰船数: ${(player.ships || []).length}
舰船详情: ${shipsPreview}
【敌方舰队】
${enemiesPreview}
【玩家资源】${state.player_resources || 0} 矿石
【玩家T级】T${state.player_tier ?? 9}
【游戏时间】${state.game_time || 0} 秒
【历史决策】
${hist}
请给出下一步决策。返回JSON格式（不要markdown代码块，只返回JSON）：
{"fleet_id": "recon", "action": "attack|retreat|flank|patrol|defend", "target": [x, z], "reason": "简短理由"}
决策原则：
1. 某支敌方舰队血量低于30%，让它撤退或防守
2. 血量优势时，分兵包抄（flank）或主动进攻
3. 玩家资源多但舰船少，全力进攻
4. 避免所有舰队同时行动，保持战术多样性
5. fleet_id 必须是敌方舰队名之一：recon / main / flagship / ai_dock / ai_miner / wild`;
}

// ---------------- LLM 调用（原生 fetch，Node 18+ 内置） ----------------
async function callLLM(prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  try {
    const resp = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.3,
        enable_thinking: false, // 关闭 reasoning：31s → ~1s，且输出纯 JSON
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
    const data = await resp.json();
    let content = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
    content = content.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    return JSON.parse(content);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- 降级规则（与 fallback.py 对齐） ----------------
function ruleBasedDecision(state) {
  const player = state.player_fleet || {};
  const enemies = state.enemy_fleets || {};
  const playerHp = player.total_hp || 0;
  const playerCount = (player.ships || []).length;
  for (const [fleetId, fleet] of Object.entries(enemies)) {
    const enemyHp = (fleet && fleet.total_hp) || 0;
    if (enemyHp < playerHp * 0.5) {
      return { fleet_id: fleetId, action: 'retreat', target: [0, 0], reason: '血量劣势，撤退' };
    }
    if (enemyHp > playerHp * 1.5) {
      return { fleet_id: fleetId, action: 'attack', target: player.avg_pos || [0, 0], reason: '血量优势，进攻' };
    }
  }
  return { fleet_id: 'recon', action: 'patrol', target: [0, 0], reason: '默认巡逻' };
}

// ---------------- 路由 ----------------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
      'Access-Control-Allow-Headers': 'Content-Type, x-gateway-key',
    });
    return res.end();
  }

  // 健康检查（保留原网关行为）
  if (req.method === 'GET' && (path === '/' || path === '/health')) {
    return sendJson(res, 200, { ok: true, service: 'ai-gateway', time: new Date().toISOString() });
  }

  // AI 决策接口
  if (req.method === 'POST' && path === '/decision') {
    if (SERVER_TOKEN && (req.headers['x-gateway-key'] || '') !== SERVER_TOKEN) {
      return sendJson(res, 401, { type: 'error', reason: 'unauthorized' });
    }
    const state = await readBody(req);
    const prompt = buildPrompt(state);
    let decision = null;
    try {
      decision = await callLLM(prompt);
    } catch (e) {
      console.error('[gateway] LLM 失败:', e.message);
    }
    if (!decision) decision = ruleBasedDecision(state);
    decisionHistory.push(decision);
    if (decisionHistory.length > 10) decisionHistory.shift();
    return sendJson(res, 200, decision);
  }

  return sendJson(res, 404, { type: 'error', reason: 'not found' });
}

const server = http.createServer(handle);

// 腾讯云 SCF Web 函数模式：平台会把请求交给 listen 后的 server；直接启动监听即可。
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[gateway] Fleet Protocol AI 网关启动 :${PORT} model=${MODEL}`);
    if (!API_KEY) console.log('[gateway] 警告：未设置 DASHSCOPE_API_KEY，仅运行规则降级模式');
    if (!SERVER_TOKEN) console.log('[gateway] 警告：未设置 SERVER_TOKEN，任何能访问者都可能消耗你的 API 额度！');
  });
} else {
  // 供 SCF 平台 require 时导出
  module.exports = { server, handle, ruleBasedDecision, buildPrompt };
}
