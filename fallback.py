# bridge/fallback.py
"""当 LLM API 不可用时的降级决策规则（纯规则，不依赖任何 API）。"""
import json


def rule_based_decision(state: dict) -> dict:
    """根据血量/数量对比给出简单规则决策，保证桥接断开时游戏不卡死。"""
    player = state.get("player_fleet", {})
    enemies = state.get("enemy_fleets", {})

    player_hp = float(player.get("total_hp", 0))
    player_count = len(player.get("ships", []))
    player_pos = player.get("avg_pos", [0.0, 0.0])

    if not enemies:
        return {
            "fleet_id": "recon",
            "action": "patrol",
            "target": player_pos,
            "reason": "无已知敌情，默认巡逻",
        }

    # 逐舰队按血量对比决策
    for fleet_id, fleet in enemies.items():
        enemy_hp = float(fleet.get("total_hp", 0))
        enemy_count = len(fleet.get("ships", []))

        # 己方严重劣势（血量 < 玩家 40%）→ 撤退
        if enemy_hp < player_hp * 0.4:
            return {
                "fleet_id": fleet_id,
                "action": "retreat",
                "target": player_pos,
                "reason": f"己方血量劣势（{enemy_hp:.0f} < 玩家 {player_hp:.0f}），撤退整补",
            }
        # 己方明显优势（血量 > 玩家 1.5 倍）→ 进攻
        if enemy_hp > player_hp * 1.5:
            return {
                "fleet_id": fleet_id,
                "action": "attack",
                "target": player_pos,
                "reason": f"己方血量优势（{enemy_hp:.0f} > 玩家 {player_hp:.0f}），全力进攻",
            }
        # 数量优势但血量接近 → 分兵包抄
        if enemy_count > player_count and enemy_hp > player_hp:
            return {
                "fleet_id": fleet_id,
                "action": "flank",
                "target": player_pos,
                "reason": "数量占优，分兵包抄夹击玩家",
            }

    return {
        "fleet_id": "recon",
        "action": "patrol",
        "target": player_pos,
        "reason": "态势均衡，保持巡逻观察",
    }
