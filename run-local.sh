#!/bin/bash
set -e

CONTAINER_NAME="docker-monitor-mcp"
IMAGE_NAME="docker-monitor-mcp-server:local"
PORT="8081"

echo "🛠️ 1. Dockerイメージのビルドを開始します ($IMAGE_NAME)..."
docker build -t "$IMAGE_NAME" .

echo "🛑 2. 既存のコンテナ ($CONTAINER_NAME) があれば停止・削除します..."
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

echo "🚀 3. 新しいコンテナをバックグラウンドで起動します (ポート: $PORT)..."
docker run -d --name "$CONTAINER_NAME" -p "$PORT:8081" \
  --env-file development.env \
  -v /var/run/docker.sock:/var/run/docker.sock \
  "$IMAGE_NAME"

echo "✅ 起動完了！"
docker ps | grep "$CONTAINER_NAME"
