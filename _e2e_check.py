# bridge/_e2e_check.py
# 跨进程端到端验证：连接 Godot 的 WebSocket 服务器 → hello → 收广播状态 →
# 发一条规则决策指令 → 确认 Godot 已收到（由 Godot 侧打印确认）。
import asyncio
import json
import sys

try:
    import websockets
except ImportError:
    print("[E2E] 缺少 websockets，请先 pip install websockets")
    sys.exit(1)


async def main():
    try:
        async with websockets.connect("ws://127.0.0.1:8765", open_timeout=5) as ws:
            print("[E2E] 已连接 Godot")
            await ws.send(json.dumps({"type": "hello"}))
            # 等第一条状态广播
            got_state = False
            for _ in range(10):
                msg = await asyncio.wait_for(ws.recv(), timeout=2.0)
                state = json.loads(msg)
                if "player_fleet" in state and "enemy_fleets" in state:
                    got_state = True
                    print(f"[E2E] 收到状态广播：玩家 {len(state['player_fleet'].get('ships', []))} 艘 / "
                          f"敌舰队 {list(state['enemy_fleets'].keys())} / 矿 {state.get('player_resources')}")
                    break
            if not got_state:
                print("[E2E] ❌ 未收到有效状态广播")
                sys.exit(1)
            # 发一条规则决策（模拟 bridge.py 的 fallback）
            decision = {"fleet_id": "recon", "action": "patrol",
                        "target": [100.0, 100.0], "reason": "e2e 规则降级决策"}
            await ws.send(json.dumps(decision))
            print("[E2E] 已发送决策指令:", json.dumps(decision, ensure_ascii=False))
            await asyncio.sleep(1.0)
            print("[E2E] ✅ 客户端侧通过（Godot 侧日志确认收到）")
    except Exception as e:
        print(f"[E2E] ❌ 失败: {e}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
