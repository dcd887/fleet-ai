# bridge/bridge.py
# AI 指挥官桥接进程：连接 Godot 的 WebSocket 服务器(8765) → 接收游戏状态 →
# 调用 LLM(DeepSeek/豆包，OpenAI 兼容接口) 决策 → 把 JSON 指令发回 Godot 执行。
# API 不可用时自动降级到 fallback.py 规则决策，不会让游戏卡死。
#
# 运行：pip install websockets openai
#       set DEEPSEEK_API_KEY=你的key（或用 config.json 的 api_key 字段）
#       python bridge/bridge.py
import asyncio
import json
import os
import sys

try:
    import websockets
except ImportError:
    print("[Bridge] 缺少依赖 websockets，请先执行: pip install websockets openai")
    sys.exit(1)

try:
    from openai import OpenAI
except ImportError:
    print("[Bridge] 缺少依赖 openai，请先执行: pip install websockets openai")
    sys.exit(1)

from fallback import rule_based_decision

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")


def load_config() -> dict:
    cfg = {
        "ws_url": "ws://127.0.0.1:8765",
        "decision_interval": 5.0,
        "api_key": "",
        "base_url": "https://api.deepseek.com",
        "model": "deepseek-chat",
        "fallback_enabled": True,
        "log_decisions": True,
    }
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg.update(json.load(f))
    # 环境变量优先（不把 key 硬编码进配置文件）
    cfg["api_key"] = os.getenv("SILICONFLOW_API_KEY", os.getenv("DEEPSEEK_API_KEY", cfg.get("api_key", "")))
    return cfg


CONFIG = load_config()

client = None
if CONFIG.get("api_key"):
    client = OpenAI(api_key=CONFIG["api_key"], base_url=CONFIG.get("base_url", "https://api.deepseek.com"))
else:
    print("[Bridge] 警告：未设置 DEEPSEEK_API_KEY，仅运行规则降级模式")

# 决策历史：让 LLM 保持战术连贯（前后不矛盾）
decision_history = []


def build_prompt(state: dict) -> str:
    """把游戏状态转成 LLM 能理解的指挥官 prompt（要求输出稳定 JSON）"""
    player = state.get("player_fleet", {})
    enemies = state.get("enemy_fleets", {})
    ships = player.get("ships", [])
    enemy_ids = sorted(enemies.keys()) if enemies else ["recon", "main", "flagship"]

    prompt = f"""你是太空舰队指挥官，指挥敌方舰队。
当前战场中可指挥的敌方舰队 fleet_id 只有这些：{', '.join(enemy_ids)}（不能编造其他 id）。
当前战场状态：
【玩家舰队】
位置: {player.get('avg_pos', [0, 0])}
总血量: {player.get('total_hp', 0)}
舰船数: {len(ships)}
舰船详情: {json.dumps(ships[:5], ensure_ascii=False)}
【敌方舰队】
{json.dumps(enemies, ensure_ascii=False, indent=2)[:800]}
【玩家资源】{state.get('player_resources', 0)} 矿石
【玩家T级】T{state.get('player_tier', 9)}
【游戏时间】{state.get('game_time', 0):.1f} 秒
【历史决策】
{json.dumps(decision_history[-3:], ensure_ascii=False)}
请给出下一步决策。只返回 JSON（不要 markdown 代码块）：
{{"fleet_id": "{enemy_ids[0]}", "action": "attack|retreat|flank|patrol|defend", "target": [x, z], "reason": "简短理由"}}
决策原则：
1. fleet_id 必须严格等于上面列表中的某一个
2. 己方血量低于 30% → retreat 或 defend
3. 己方血量优势 → attack 或 flank（分兵包抄）
4. 玩家资源多但舰船少 → 主动进攻
5. 避免所有舰队同时做同一动作，保持战术多样性
6. 结合历史决策避免前后矛盾（不要刚进攻完立刻撤退）"""
    return prompt


async def call_llm(prompt: str) -> dict:
    """调用 LLM 获取决策；失败返回 None（由调用方降级）"""
    if client is None:
        return None
    try:
        response = client.chat.completions.create(
            model=CONFIG.get("model", "deepseek-chat"),
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            timeout=30,
        )
        content = response.choices[0].message.content.strip()
        # 清理可能的 markdown 代码块
        if content.startswith("```"):
            content = content.split("```")[1]
            if content.lstrip().startswith("json"):
                content = content.lstrip()[4:]
        content = content.strip()
        return json.loads(content)
    except Exception as e:
        print(f"[Bridge] LLM 调用失败: {e}")
        return None


async def ai_commander(websocket):
    """主循环：接收状态 → 决策 → 发回指令"""
    last_decision = 0.0
    loop = asyncio.get_event_loop()
    print("[Bridge] 已连接到 Godot，等待状态…")

    async for message in websocket:
        try:
            state = json.loads(message)
        except json.JSONDecodeError:
            continue

        now = loop.time()
        if now - last_decision < float(CONFIG.get("decision_interval", 5.0)):
            continue
        last_decision = now

        print(f"[Bridge] 收到状态：玩家血量 {state.get('player_fleet', {}).get('total_hp', 0)}，"
              f"敌舰队 {list(state.get('enemy_fleets', {}).keys())}")

        decision = await call_llm(build_prompt(state))
        if decision is None:
            if CONFIG.get("fallback_enabled", True):
                decision = rule_based_decision(state)
                print(f"[Bridge] LLM 不可用 → 规则降级: {decision}")
            else:
                continue
        elif not isinstance(decision.get("action"), str) or "fleet_id" not in decision:
            if CONFIG.get("fallback_enabled", True):
                decision = rule_based_decision(state)
            else:
                continue
        # 校验并修正：fleet_id / action 必须落在真实枚举内，否则就近修正或降级
        enemy_ids = list(state.get("enemy_fleets", {}).keys()) or ["recon", "main", "flagship"]
        valid_actions = {"attack", "retreat", "flank", "patrol", "defend"}
        if decision.get("fleet_id") not in enemy_ids or decision.get("action") not in valid_actions:
            print(f"[Bridge] LLM 决策含非法值（fleet_id={decision.get('fleet_id')} action={decision.get('action')}），就近修正")
            if decision.get("fleet_id") not in enemy_ids:
                # 就近修正：指向血量最高的舰队（LLM 意图大概率是最强主力）
                best_id = max(enemy_ids, key=lambda fid: state["enemy_fleets"][fid].get("total_hp", 0))
                decision["fleet_id"] = best_id
            if decision.get("action") not in valid_actions:
                decision["action"] = "patrol"

        # 记录决策历史，保持战术连贯
        decision_history.append(decision)
        if len(decision_history) > 10:
            decision_history.pop(0)

        if CONFIG.get("log_decisions", True):
            print(f"[Bridge] 发送决策: {json.dumps(decision, ensure_ascii=False)}")
        await websocket.send(json.dumps(decision))


async def main():
    while True:
        try:
            async with websockets.connect(CONFIG.get("ws_url", "ws://127.0.0.1:8765")) as ws:
                await ai_commander(ws)
        except Exception as e:
            print(f"[Bridge] 连接断开/失败: {e}，5 秒后重连…")
            await asyncio.sleep(5)


if __name__ == "__main__":
    if not CONFIG.get("api_key"):
        print("[Bridge] 未配置 API key：将只使用规则降级决策（fallback.py）。")
        print("[Bridge] 如需接入 LLM：set DEEPSEEK_API_KEY=你的key")
    asyncio.run(main())
