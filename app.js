const express = require("express");
const app = express();
app.use(express.json({ limit: "2mb" }));
// ===== 配置区 =====
const MODEL_WHITELIST = [];
// 网关密钥建议改成从环境变量读，防止密钥进代码仓库
const GATEWAY_KEY = process.env.GATEWAY_KEY || "";
// ===== 保护参数（新增，均可通过环境变量调整）=====
// /chat 响应 token 硬上限（防止被拿去跑长文本烧钱）；/decision 不受影响
const MAX_TOKENS_CAP = parseInt(process.env.MAX_TOKENS_CAP || "512", 10);
// /chat 对话轮数上限
const MAX_MESSAGES = parseInt(process.env.MAX_MESSAGES || "40", 10);
// /chat 限流：单 IP 每分钟次数；0 表示关闭
const RATE_IP_MIN = parseInt(process.env.RATE_IP_MIN || "5", 10);
// /chat 限流：全网关每天总次数；0 表示关闭
const RATE_GLOBAL_DAY = parseInt(process.env.RATE_GLOBAL_DAY || "500", 10);
// ===== DashScope（阿里百炼）上游：设置 DASHSCOPE_API_KEY 后 /chat 与 /decision 都优先走它 =====
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || "";
const DASHSCOPE_BASE_URL = process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
// /chat 在 DashScope 上使用的模型（默认 qwen3-8b；审讯效果不满意可改 deepseek-r1 / qwen-plus 等）
const CHAT_MODEL_DASH = process.env.CHAT_MODEL || "qwen3-8b";
// 前端仍发 SiliconFlow 风格模型名，网关自动映射到 CHAT_MODEL_DASH（支持逗号分隔多个，匹配任一即映射）
const CHAT_MODEL_MAP = (process.env.CHAT_MODEL_MAP || "deepseek-ai/DeepSeek-R1-0528-Qwen3-8B")
  .split(",").map((s) => s.trim()).filter(Boolean);
// ===== CORS =====
app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-gateway-key",
    "Access-Control-Max-Age": "86400",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
// ===== 健康检查 =====
app.get(["/", "/health"], (req, res) => {
  res.json({ ok: true, service: "ai-gateway", time: new Date().toISOString() });
});
/* ===== /chat 限流（新增，单实例内存计数；不影响 /decision）===== */
const ipBuckets = new Map();
let globalDayStart = Date.now();
let globalDayCount = 0;
function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "unknown";
}
function rateLimited(req) {
  if (RATE_IP_MIN <= 0 && RATE_GLOBAL_DAY <= 0) return false;
  const now = Date.now();
  const minute = 60 * 1000;
  const day = 24 * 60 * 60 * 1000;
  if (RATE_GLOBAL_DAY > 0) {
    if (now - globalDayStart > day) { globalDayStart = now; globalDayCount = 0; }
    globalDayCount += 1;
    if (globalDayCount > RATE_GLOBAL_DAY) return true;
  }
  if (RATE_IP_MIN > 0) {
    const ip = clientIp(req);
    const b = ipBuckets.get(ip);
    if (!b || now - b.start > minute) {
      ipBuckets.set(ip, { start: now, count: 1 });
      return false;
    }
    b.count += 1;
    return b.count > RATE_IP_MIN;
  }
  return false;
}
// ===== AI 对话转发 =====
app.post("/chat", async (req, res) => {
  if (GATEWAY_KEY && (req.headers["x-gateway-key"] || "") !== GATEWAY_KEY) {
    return res.status(401).json({ error: "unauthorized", message: "网关密钥无效" });
  }
  // 限流（新增）
  if (rateLimited(req)) {
    return res.status(429).json({ error: "rate_limited", message: "请求过于频繁，请稍后再试" });
  }
  const model = (req.body && req.body.model) || "deepseek-ai/DeepSeek-R1-0528-Qwen3-8B";
  if (MODEL_WHITELIST.length > 0 && !MODEL_WHITELIST.includes(model)) {
    return res.status(403).json({ error: "model_forbidden", message: `模型 ${model} 不在白名单` });
  }
  // 消息结构校验（新增）
  const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
  if (messages.length === 0) {
    return res.status(400).json({ error: "invalid_messages", message: "messages 不能为空" });
  }
  if (messages.length > MAX_MESSAGES) {
    return res.status(400).json({ error: "too_many_messages", message: `对话轮数超过上限 ${MAX_MESSAGES}` });
  }
  // 上游选择：配置了 DASHSCOPE_API_KEY 则 /chat 走 DashScope（含模型名映射），否则回落 SiliconFlow
  const useDashChat = !!DASHSCOPE_API_KEY;
  const upstream = useDashChat ? DASHSCOPE_BASE_URL : (process.env.LLM_BASE_URL || "https://api.siliconflow.cn/v1/chat/completions");
  const apiKey = useDashChat ? DASHSCOPE_API_KEY : process.env.LLM_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "server_misconfigured", message: "网关未配置上游 API Key" });
  // token 硬上限（新增：原 4096 改为环境变量 MAX_TOKENS_CAP，默认 512）
  const reqMax = typeof req.body.max_tokens === "number" ? req.body.max_tokens : 1024;
  // 模型名映射：DashScope 模式下把 SiliconFlow 风格模型名换成 DashScope 模型
  const outModel = useDashChat && CHAT_MODEL_MAP.includes(model) ? CHAT_MODEL_DASH : model;
  const payload = {
    model: outModel,
    messages,
    temperature: typeof req.body.temperature === "number" ? req.body.temperature : 0.7,
    max_tokens: Math.min(reqMax, MAX_TOKENS_CAP),
    stream: false,
  };
  // DashScope 的 qwen3 系列思考模型：非流式调用必须显式关闭思考，否则百炼返回 400
  if (useDashChat) payload.enable_thinking = false;
  try {
    const upstreamRes = await fetch(upstream, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });
    const text = await upstreamRes.text();
    res.status(upstreamRes.status).set("Content-Type", "application/json").send(text);
  } catch (e) {
    res.status(502).json({ error: "upstream_error", message: `上游 API 不可达：${e.message}` });
  }
});
// ================================================================
// ===== 新增：AI 舰队决策接口（Godot 端 HTTP 轮询 POST /decision）=====
// ===== 此接口服务于另一款太空舰队游戏，禁止删除 =====================
// ================================================================
const DECISION_MODEL = process.env.DECISION_MODEL || "Qwen/Qwen3-8B"; // 决策用模型（可关思考）
let decisionHistory = []; // 保持战术连贯
function buildDecisionPrompt(state) {
  const player = state.player_fleet || {};
  const enemies = state.enemy_fleets || {};
  return `你是一个太空舰队指挥官，指挥多支敌方舰队。
当前战场状态：
【玩家舰队】
位置: ${JSON.stringify(player.avg_pos || [0, 0])}
总血量: ${player.total_hp || 0}
舰船数: ${(player.ships || []).length}
舰船详情: ${JSON.stringify((player.ships || []).slice(0, 5))}
【敌方舰队】
${JSON.stringify(enemies).slice(0, 800)}
【玩家资源】${state.player_resources || 0} 矿石
【玩家T级】T${state.player_tier ?? 9}
【游戏时间】${state.game_time || 0} 秒
【历史决策】
${JSON.stringify(decisionHistory.slice(-3))}
请给出下一步决策。返回JSON格式（不要markdown代码块，只返回JSON）：
{"fleet_id": "recon", "action": "attack|retreat|flank|patrol|defend", "target": [x, z], "reason": "简短理由"}
决策原则：
1. 某支敌方舰队血量低于30%，让它撤退或防守
2. 血量优势时，分兵包抄（flank）或主动进攻
3. 玩家资源多但舰船少，全力进攻
4. 避免所有舰队同时行动，保持战术多样性
5. fleet_id 必须是敌方舰队名之一：recon / main / flagship / ai_dock / ai_miner / wild`;
}
function fallbackDecision(state) {
  const player = state.player_fleet || {};
  const enemies = state.enemy_fleets || {};
  const playerHp = player.total_hp || 0;
  for (const [fleetId, fleet] of Object.entries(enemies)) {
    const enemyHp = (fleet && fleet.total_hp) || 0;
    if (enemyHp < playerHp * 0.5) {
      return { fleet_id: fleetId, action: "retreat", target: [0, 0], reason: "血量劣势，撤退" };
    }
    if (enemyHp > playerHp * 1.5) {
      return { fleet_id: fleetId, action: "attack", target: player.avg_pos || [0, 0], reason: "血量优势，进攻" };
    }
  }
  return { fleet_id: "recon", action: "patrol", target: [0, 0], reason: "默认巡逻" };
}
app.post("/decision", async (req, res) => {
  if (GATEWAY_KEY && (req.headers["x-gateway-key"] || "") !== GATEWAY_KEY) {
    return res.status(401).json({ error: "unauthorized", message: "网关密钥无效" });
  }
  const state = req.body || {};
  // 决策模型上游：优先 DashScope（阿里 Qwen，便宜），未配置 DASHSCOPE_API_KEY 时回落 SiliconFlow
  const dashKey = process.env.DASHSCOPE_API_KEY;
  const decisionApiKey = dashKey || process.env.LLM_API_KEY;
  const decisionBase = dashKey
    ? (process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions")
    : (process.env.LLM_BASE_URL || "https://api.siliconflow.cn/v1/chat/completions");
  const decisionModel = dashKey ? (process.env.DASHSCOPE_MODEL || "qwen3-8b") : DECISION_MODEL;
  let decision = null;
  if (decisionApiKey) {
    const payload = {
      model: decisionModel,
      messages: [{ role: "user", content: buildDecisionPrompt(state) }],
      temperature: 0.3,
      max_tokens: 200,
      stream: false,
      enable_thinking: false, // 关键：关闭思考，31s → ~1s，输出纯 JSON
    };
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000); // 8s 超时，低于 Godot 端 12s
      const upstreamRes = await fetch(
        decisionBase,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${decisionApiKey}` },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        }
      );
      clearTimeout(timer);
      const text = await upstreamRes.text();
      let content = "";
      try { content = JSON.parse(text).choices[0].message.content; } catch (e) { content = text; }
      content = String(content).replace(/^```(json)?/i, "").replace(/```$/, "").trim();
      const parsed = JSON.parse(content);
      if (parsed && parsed.action && parsed.fleet_id) decision = parsed;
    } catch (e) {
      console.error("[decision] LLM 失败:", e.message);
    }
  }
  if (!decision) decision = fallbackDecision(state);
  decisionHistory.push(decision);
  if (decisionHistory.length > 10) decisionHistory.shift();
  res.json(decision);
});
app.listen(9000, () => console.log("ai-gateway listening on 9000"));
