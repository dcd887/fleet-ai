# bridge/_llm_probe.py
# 连通性测试：用 config.json 的 key/model/base_url 调用一次 LLM，验证真实接入可用。
import json
import os
import sys

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
with open(CONFIG_PATH, "r", encoding="utf-8") as f:
    cfg = json.load(f)

key = os.getenv("DEEPSEEK_API_KEY", cfg.get("api_key", ""))
base_url = cfg.get("base_url", "")
model = cfg.get("model", "")
print(f"[PROBE] base_url={base_url} model={model} key={key[:8]}...{key[-4:] if len(key) > 12 else ''}")

try:
    from openai import OpenAI
except ImportError:
    print("[PROBE] ❌ 缺少 openai 库")
    sys.exit(1)

if not key:
    print("[PROBE] ❌ 无 api_key（环境变量 DEEPSEEK_API_KEY 与 config.json 均为空）")
    sys.exit(1)

client = OpenAI(api_key=key, base_url=base_url, timeout=20)
try:
    resp = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": "你是太空舰队指挥官。只输出 JSON。"},
            {"role": "user", "content": "玩家舰队血量占优，敌方舰队劣势。给出下一步决策，格式：{\"fleet_id\":\"recon\",\"action\":\"attack\",\"target\":[0,0],\"reason\":\"血量优势\"}"},
        ],
        max_tokens=120,
        temperature=0.3,
    )
    content = resp.choices[0].message.content.strip()
    print("[PROBE] ✅ LLM 调用成功，返回：", content[:200])
except Exception as e:
    print(f"[PROBE] ❌ LLM 调用失败: {type(e).__name__}: {e}")
    sys.exit(1)
