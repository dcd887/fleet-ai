# bridge/_free_probe.py
# 免费模型连通性探测：遍历 flash 免费档，找当前 key 可用的免费模型。
import json
import os

from openai import OpenAI

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
with open(CONFIG_PATH, "r", encoding="utf-8") as f:
    cfg = json.load(f)

client = OpenAI(api_key=cfg["api_key"], base_url=cfg["base_url"], timeout=20)
cands = ["qwen-flash", "qwen3.5-flash", "qwen3.6-flash", "qwen3.7-flash", "qwen3.8-flash", "deepseek-v4-flash"]
for m in cands:
    try:
        r = client.chat.completions.create(
            model=m, messages=[{"role": "user", "content": "只回答：OK"}], max_tokens=5, temperature=0
        )
        print(f"[{m}] OK:", r.choices[0].message.content[:20])
    except Exception as e:
        print(f"[{m}] FAIL:", str(e)[:100])
