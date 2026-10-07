@echo off
REM ============================================================
REM  Fleet Protocol - AI 指挥官启动器
REM
REM  模式1：本地开发（默认）——Godot 开 8765 端口，本脚本连它
REM     先设置：set DASHSCOPE_API_KEY=你的阿里云key
REM     运行：  start_ai.bat
REM     游戏端：正常启动（不要加 --ai-server 参数）
REM
REM  模式2：本机模拟"上线远程服务器"——Godot 直连 bridge_server.py
REM     先设置：set DASHSCOPE_API_KEY=你的阿里云key
REM     运行：  start_ai.bat server
REM     游戏端：Godot 加参数  --ai-server ws://127.0.0.1:8080 --ai-token dev123
REM ============================================================
setlocal
cd /d %~dp0

if "%1"=="server" (
    if not defined SERVER_TOKEN set SERVER_TOKEN=dev123
    echo [AI] 启动远程模式服务器（端口 8080，token=%SERVER_TOKEN%）
    python bridge_server.py
) else (
    echo [AI] 启动本地 bridge.py（连接 Godot 8765 端口）
    python bridge.py
)
endlocal
