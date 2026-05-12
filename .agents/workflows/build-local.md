---
description: ローカルのDockerコンテナでdocker-monitor-mcp-serverをビルド・起動する
---

// turbo-all
1. 古いコンテナ(`docker-monitor-mcp`)が動いていれば停止・削除します
```bash
docker rm -f docker-monitor-mcp || true
```

2. Dockerイメージをビルドします
```bash
docker build -t docker-monitor-mcp-server:local .
```

3. コンテナをバックグラウンドで起動します（ポート8081番）
```bash
docker run -d --name docker-monitor-mcp -p 8081:8081 \
  --env-file development.env \
  -v /var/run/docker.sock:/var/run/docker.sock \
  docker-monitor-mcp-server:local
```

4. 起動ステータスを確認します
```bash
docker ps | grep docker-monitor-mcp
```
