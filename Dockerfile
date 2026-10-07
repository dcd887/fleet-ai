# Fleet Protocol AI Commander 服务器镜像
# 注意：只精确 COPY 运行所需文件，绝不 COPY config.json（本地含 API key）
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY bridge_server.py fallback.py ./
ENV PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python", "bridge_server.py"]
