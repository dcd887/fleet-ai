# Fleet Protocol · AI 指挥官上线部署指南

## 架构（上线版）

```
玩家电脑                         你的服务器（免费平台即可）              阿里云 DashScope API
┌──────────────┐   WebSocket   ┌──────────────────┐   OpenAI兼容   ┌──────────────┐
│ Godot 游戏    │ ───────────▶  │ bridge_server.py │ ────────────▶ │ qwen3.7-flash │
│ (exe，无key)  │ ◀───────────  │ (key 在环境变量) │ ◀──────────── │  (key 只在这) │
└──────────────┘                └──────────────────┘                └──────────────┘
```

**安全性**：API key 只存在于你服务器的环境变量，玩家的 exe 里只有服务器地址和访问令牌（SERVER_TOKEN，可随时更换）。玩家永远拿不到你的 key。

## 一、本地测试（模拟上线）

```bat
cd bridge
set DASHSCOPE_API_KEY=你的阿里云 DashScopekey
start_ai.bat server          rem 或直接: python bridge_server.py
```

游戏启动参数（编辑器的 Custom Args 或 exe 命令行）：
```
--ai-server ws://127.0.0.1:8080 --ai-token dev123
```

## 二、部署到免费平台（任选其一）

### 方案 A：Render（推荐，最简单）
1. 注册 render.com，New → Web Service
2. 连接你的 GitHub 仓库，根目录选 `bridge/`
3. 构建命令：`pip install websockets openai`
4. 启动命令：`python bridge_server.py`
5. 环境变量填：
   - `DASHSCOPE_API_KEY` = 你的 key
   - `SERVER_TOKEN` = 一串随机字符串（你生成的访问令牌）
   - `PORT` = 8080（Render 会注入）
6. 部署后得到 URL，如 `https://fleet-ai.onrender.com`
7. 玩家端 exe 启动参数：`--ai-server wss://fleet-ai.onrender.com --ai-token 那串随机字符串`

### 方案 B：Railway / Fly.io
同样的思路：跑 `bridge_server.py`，暴露 8080 端口，设 3 个环境变量。

### 方案 C：自己的 VPS
```bash
pip install websockets openai
DASHSCOPE_API_KEY=xxx SERVER_TOKEN=yyy python bridge_server.py
# 用 systemd / docker 守护，Nginx 反代 wss
```

## 三、玩家发布

打包 exe 时**不要**包含 `bridge/` 目录（里面有 config/脚本，虽然 key 已不在文件里，但不必要）。
游戏内把 AI 服务器地址做成设置项（后续版本），或固定写死在启动参数。

## 四、重要安全提醒

1. **SERVER_TOKEN 必须设置**——不设的话任何能连到你服务器的人都能白嫖你的 API 额度。
2. 令牌泄露 = 被白嫖额度，但拿不到 key。泄露后可随时换令牌重启服务器。
3. 服务器可加 IP 限流/每令牌频率限制（后续版本做）。
4. 免费平台休眠问题：Render 免费实例 15 分钟无请求会休眠，第一局 AI 决策会慢几秒（唤醒延迟）。付费实例或常驻 VPS 无此问题。

## 五、本地开发（不发布时）

开发时用旧模式即可，Godot 自动开 8765 端口，跑：
```bat
cd bridge
set DASHSCOPE_API_KEY=你的key
python bridge.py
```
游戏正常启动即可（不要加 --ai-server 参数）。

