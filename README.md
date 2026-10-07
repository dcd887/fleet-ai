# Fleet Protocol · AI Commander Server

《舰队协议》的敌方舰队 AI 指挥官服务器。游戏（Godot）通过 WebSocket 连接本服务，本服务调用 LLM 实时决策，再把战术指令回传游戏。

**安全设计**：API key 只存在服务器环境变量，玩家端 exe 只含服务器地址 + 访问令牌（SERVER_TOKEN），永远拿不到 key。

## 技术栈
- Python 3.10+ / websockets / openai
- LLM：阿里云 DashScope `qwen3.7-flash`（OpenAI 兼容接口）
- 部署：Render Blueprint（`render.yaml`）

## 部署（Render 免费层）
1. 把本仓库推到 GitHub
2. Render → New → Blueprint → 选本仓库（自动识别 `render.yaml`）
3. 服务页配置环境变量：
   - `DASHSCOPE_API_KEY`：阿里云 DashScope key（必填）
   - `SERVER_TOKEN`：自定一串随机字符（必填，玩家 exe 里带这个）
4. Deploy，拿到 `https://fleet-ai.onrender.com`
5. 玩家 exe 启动参数：`--ai-server wss://fleet-ai.onrender.com --ai-token 你的SERVER_TOKEN`

## 本地开发
```bat
pip install -r requirements.txt
set DASHSCOPE_API_KEY=你的key
python bridge.py            rem 连接 Godot 的 8765 端口（本地模式）
python bridge_server.py     rem 或本机模拟上线服务器（端口 8080）
```
Godot 端远程模式：`--ai-server ws://127.0.0.1:8080 --ai-token dev123`

## 说明
- `config.json` 被 gitignore（含本地开发 key，绝不入库）；服务器部署只读环境变量。
- LLM 超时/失败自动降级 `fallback.py` 规则决策，游戏不会卡死。
- 详见 `DEPLOY.md`。
