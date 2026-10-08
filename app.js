const express = require("express");
const app = express();
app.use(express.json({ limit: "2mb" }));
// ===== 配置区 =====
const MODEL_WHITELIST = [];
// 网关密钥建议改成从环境变量读，防止密钥进代码仓库
const GATEWAY_KEY = process.env.GATEWAY_KEY || "";
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
// ===== AI 对话转发 =====
app.post("/chat", async (req, res) => {
  if (GATEWAY_KEY && (req.headers["x-gateway-key"] || "") !== GATEWAY_KEY) {
    return res.status(401).json({ error: "unauthorized", message: "网关密钥无效" });
  }
  const model = (req.body && req.body.model) || "deepseek-ai/DeepSeek-R1-0528-Qwen3-8B";
  if (MODEL_WHITELIST.length > 0 && !MODEL_WHITELIST.includes(model)) {
    return res.status(403).json({ error: "model_forbidden", message: `模型 ${model} 不在白名单` });
  }
  const upstream = process.env.LLM_BASE_URL || "https://api.siliconflow.cn/v1/chat/completions";
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "server_misconfigured", message: "网关未配置 LLM_API_KEY" });
  const payload = {
    model,
    messages: Array.isArray(req.body.messages) ? req.body.messages : [],
    temperature: typeof req.body.temperature === "number" ? req.body.temperature : 0.7,
    max_tokens: typeof req.body.max_tokens === "number" ? Math.min(req.body.max_tokens || 1024, 4096) : 1024,
    stream: false,
  };
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
  const apiKey = process.env.LLM_API_KEY;
  let decision = null;
  if (apiKey) {
    const payload = {
      model: DECISION_MODEL,
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
        process.env.LLM_BASE_URL || "https://api.siliconflow.cn/v1/chat/completions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
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
