# bridge/bridge_server.py
# 远程 AI 指挥官服务器（上线方案核心）：
#   Godot 游戏（WebSocket 客户端）→ 本服务器 → 硅基流动 LLM → 决策回传
# 特性：
#   - API key 只从环境变量 SILICONFLOW_API_KEY 读取，绝不写入代码/配置文件
#   - 可选 server_token 鉴权（玩家 exe 内只含服务器地址 + 此 token，token 可随时更换）
#   - LLM 超时自动降级到 fallback 规则，游戏不会卡死
# 部署：任意支持 Python 3.10+ 的平台（Render / Railway / Fly.io / 自家 VPS）
#   环境变量：SILICONFLOW_API_KEY=你的key   SERVER_TOKEN=你的访问令牌   PORT=8080(可选)
# 本地测试：
#   set SILICONFLOW_API_KEY=你的key
#   set SERVER_TOKEN=dev123
#   python bridge_server.py
#   Godot 启动参数：--ai-server ws://127.0.0.1:8080 --ai-token dev123
import asyncio
import http
import json
import os
import sys
import time

try:
    import websockets
except ImportError:
    print("[Server] 缺少依赖 websockets，请先执行: pip install websockets openai")
    sys.exit(1)

# websockets 14+ 的 process_request 需返回 Response 对象；12-13 用三元组
try:
    from websockets.http11 import Response as _WSResponse
    from websockets.datastructures import Headers as _WSHeaders
    _WS_NEW_API = True
except ImportError:
    _WS_NEW_API = False

try:
    from openai import OpenAI
except ImportError:
    print("[Server] 缺少依赖 openai，请先执行: pip install websockets openai")
    sys.exit(1)

from fallback import rule_based_decision

# ---------- 配置（全部来自环境变量 / config.json，key 只走环境变量） ----------
BASE_URL = os.getenv("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
MODEL = os.getenv("AI_MODEL", "qwen3.7-flash")
API_KEY = os.getenv("DASHSCOPE_API_KEY", os.getenv("SILICONFLOW_API_KEY", ""))
SERVER_TOKEN = os.getenv("SERVER_TOKEN", "")
DECISION_INTERVAL = float(os.getenv("DECISION_INTERVAL", "5.0"))
PORT = int(os.getenv("PORT", "8080"))
LOG_DECISIONS = os.getenv("LOG_DECISIONS", "1") == "1"

if not API_KEY:
    print("[Server] 警告：未设置 DASHSCOPE_API_KEY 环境变量，仅运行规则降级模式")

client = None
if API_KEY:
    client = OpenAI(api_key=API_KEY, base_url=BASE_URL, timeout=20)

# 决策历史：保持战术连贯（每个客户端各自维护）
decision_history: dict = {}  # peer -> list


def build_prompt(state: dict) -> str:
    """把游戏状态转成 LLM 能理解的 prompt（与本地 bridge.py 相同格式）"""
    player = state.get("player_fleet", {})
    enemies = state.get("enemy_fleets", {})
    ships_preview = json.dumps(player.get("ships", [])[:5], ensure_ascii=False)
    enemies_preview = json.dumps(enemies, ensure_ascii=False, indent=2)[:800]
    hist = json.dumps(decision_history.get("last", [])[-3:], ensure_ascii=False)
    prompt = f"""你是一个太空舰队指挥官，指挥多支敌方舰队。
当前战场状态：
【玩家舰队】
位置: {player.get('avg_pos', [0, 0])}
总血量: {player.get('total_hp', 0)}
舰船数: {len(player.get('ships', []))}
舰船详情: {ships_preview}
【敌方舰队】
{enemies_preview}
【玩家资源】{state.get('player_resources', 0)} 矿石
【玩家T级】T{state.get('player_tier', 9)}
【游戏时间】{state.get('game_time', 0):.1f} 秒
【历史决策】
{hist}
请给出下一步决策。返回JSON格式（不要markdown代码块，只返回JSON）：
{{"fleet_id": "recon", "action": "attack|retreat|flank|patrol|defend", "target": [x, z], "reason": "简短理由"}}
决策原则：
1. 某支敌方舰队血量低于30%，让它撤退或防守
2. 血量优势时，分兵包抄（flank）或主动进攻
3. 玩家资源多但舰船少，全力进攻
4. 避免所有舰队同时行动，保持战术多样性
5. fleet_id 必须是敌方舰队名之一：recon / main / flagship / ai_dock / ai_miner / wild"""
    return prompt


async def call_llm(prompt: str):
    try:
        resp = client.chat.completions.create(
            model=MODEL,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=160,
            temperature=0.3,
        )
        content = resp.choices[0].message.content.strip()
        if content.startswith("```"):
            content = content.split("```")[1]
            if content.startswith("json"):
                content = content[4:]
        content = content.strip()
        return json.loads(content)
    except Exception as e:
        print(f"[Server] LLM调用失败: {type(e).__name__}: {str(e)[:120]}")
        return None


async def ai_commander(websocket):
    peer = str(websocket.remote_address)
    decision_history.setdefault(peer, [])
    last_decision_time = 0.0
    print(f"[Server] 客户端连接: {peer}")
    try:
        async for message in websocket:
            if isinstance(message, bytes):
                message = message.decode("utf-8", errors="replace")
            try:
                state = json.loads(message)
            except Exception:
                continue
            now = time.time()
            if now - last_decision_time < DECISION_INTERVAL:
                continue
            last_decision_time = now

            # 可选鉴权：客户端 hello 里带 token
            if message.strip().startswith('{"type":"hello"'):
                token = (state.get("token", "") if isinstance(state, dict) else "")
                if SERVER_TOKEN and token != SERVER_TOKEN:
                    print(f"[Server] 拒绝未授权客户端: {peer}")
                    await websocket.send(json.dumps({"type": "error", "reason": "unauthorized"}))
                    return
                print(f"[Server] 授权通过: {peer}")
                continue

            print(f"[Server] 收到状态: 玩家HP={state.get('player_fleet', {}).get('total_hp')} "
                  f"敌方编队数={len(state.get('enemy_fleets', {}))}")
            prompt = build_prompt(state)
            decision = await call_llm(prompt)
            if decision:
                decision_history[peer].append(decision)
                if len(decision_history[peer]) > 10:
                    decision_history[peer].pop(0)
                await websocket.send(json.dumps(decision))
                print(f"[Server] 发送决策: {json.dumps(decision, ensure_ascii=False)[:160]}")
            else:
                # 降级规则
                fb = rule_based_decision(state)
                await websocket.send(json.dumps(fb))
                print(f"[Server] 降级规则决策: {json.dumps(fb, ensure_ascii=False)[:120]}")
    except websockets.exceptions.ConnectionClosed:
        print(f"[Server] 客户端断开: {peer}")


async def process_request(*args):
    """Render 等平台的健康检查：非 WebSocket 的 GET / 返回 200，WebSocket 握手继续。
    兼容 websockets 12-13 (path, request_headers) 与 14+ (connection, request) 两代签名与返回格式"""
    path = None
    headers = None
    if len(args) >= 2:
        second = args[1]
        if isinstance(second, str):
            path = args[0]  # 旧版签名 (path, request_headers)
            headers = args[1]
        else:
            path = getattr(second, "path", None)  # 新版签名 request.path
            headers = getattr(second, "headers", None)
    elif len(args) == 1:
        path = getattr(args[0], "path", None)
        headers = getattr(args[0], "headers", None)
    # 仅当 path 为 / 且请求头带 Upgrade: websocket 时才是 WS 握手，放行
    if path == "/" and headers is not None:
        upgrade = headers.get("Upgrade", "") if hasattr(headers, "get") else ""
        if upgrade and "websocket" in str(upgrade).lower():
            return None  # WebSocket 握手，继续处理
        if _WS_NEW_API:
            return _WSResponse(200, "OK", _WSHeaders({"Content-Type": "text/plain; charset=utf-8"}), b"ok")
        return (http.HTTPStatus.OK, [("Content-Type", "text/plain; charset=utf-8")], b"ok")
    return None


async def main():
    print(f"[Server] 远程 AI 指挥官启动  base_url={BASE_URL} model={MODEL} 端口={PORT}")
    if SERVER_TOKEN:
        print(f"[Server] 鉴权已开启（SERVER_TOKEN）")
    else:
        print("[Server] 警告：未设置 SERVER_TOKEN，任何能连到端口的人都能使用你的 API key 额度！")
    async with websockets.serve(ai_commander, "0.0.0.0", PORT, max_size=2_000_000,
                                process_request=process_request):
        await asyncio.Future()  # 永久运行


if __name__ == "__main__":
    asyncio.run(main())
