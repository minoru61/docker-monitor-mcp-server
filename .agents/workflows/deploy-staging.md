// turbo-all
1. まず、依存パッケージの致命的な脆弱性チェックを行います
```bash
npm audit --audit-level=critical
```

2. さくらVPS用のアーキテクチャ(linux/amd64)でDockerイメージをビルドします
```bash
docker buildx build --platform linux/amd64 -t docker-monitor-mcp-server:staging --load .
```

2. Dockerイメージをtarファイルとして保存します
```bash
docker save docker-monitor-mcp-server:staging -o docker-monitor-mcp-server-staging.tar
```

3. イメージと環境設定ファイル(development.env)をステージングサーバーへ転送します
```bash
scp -i ~/.ssh/id_ed25519_vps docker-monitor-mcp-server-staging.tar development.env debian@133.167.105.49:~/
```

4. ステージングサーバーで古いコンテナを削除し、新しいイメージで起動します
```bash
ssh -i ~/.ssh/id_ed25519_vps debian@133.167.105.49 "docker load -i ~/docker-monitor-mcp-server-staging.tar && docker rm -f docker-monitor-mcp || true && docker run -d --name docker-monitor-mcp --network macosui_default -p 8081:8081 --env-file ~/development.env -v /var/run/docker.sock:/var/run/docker.sock docker-monitor-mcp-server:staging"
```

6. 最後に、ステージングサーバー上でコンテナが立ち上がっているか、またヘルスチェック（起動確認）を行います
```bash
ssh -i ~/.ssh/id_ed25519_vps debian@133.167.105.49 "docker ps | grep docker-monitor-mcp && sleep 3 && curl -sSf http://localhost:8081/mcp || echo 'MCP Server is not responding yet!'"
```
