# Model Context Protocol (MCP) セキュリティ & デプロイメントガイドライン

本書は、Model Context Protocol (MCP) サーバーを、**開発・テスト環境（同居構成）**から**本番環境（別サーバーによる分離構成）**へ移行、あるいはオープンソース (OSS) として展開するにあたり、必ず直面するネットワーク、セキュリティ、および堅牢性（ロバストネス）にまつわるトラブルと、そのベストプラクティスな解決策をまとめたガイドラインです。

特に、MariaDB や Docker モニターなどの MCP サーバーを「クライアントと同居させて検証」し、のちに「別サーバーとして本番運用」するケースにおいて、極めて有益なバイブルとなります。

---

## 1. MCP サーバーにおける2大インフラ構成

MCP（特に SSE トランスポート）を運用する場合、インフラは以下の2つのいずれかのトポロジーをとります。

| 構成パターン | 構成A: 同居（Co-located）構成 | 構成B: 分離（Distributed）構成 |
| :--- | :--- | :--- |
| **主な用途** | 開発、ステージング、テスト環境 | 本番運用、マルチテナント、別サーバー運用 |
| **位置関係** | MCPクライアントとサーバーが同一ホスト (同一Dockerネットワーク内) に同居 | MCPクライアントとサーバーが異なる物理サーバー / ネットワークに存在 |
| **ネットワーク** | `http://<container_name>:<port>` による内部直間通信 | インターネット（HTTPS / TLS暗号化）を介したセキュアな広域通信 |
| **暗号化の必要性**| 不要（内部メモリ・ブリッジ経由のため高速） | **絶対に必須（Zero Trust Architecture 準拠）** |

---

## 2. デプロイ時に直面する「3大トラブル」と根本原因・対策

同居構成（A）から分離構成（B）へ移行する際、あるいは同居構成のまま「URLを https に統一してテストしたい」という場合に、以下の3つの深刻な問題が頻発します。

---

### トラブル①：プロキシによるストリーミング堰き止め（接続タイムアウト）

#### 【現象】
接続テスト時、進捗インジケーターが「ぐるぐるマーク」のまま戻らず、最終的にゲートウェイタイムアウト（504 Gateway Timeout）になる。

#### 【原因】
SSE (Server-Sent Events) はサーバーからクライアントへイベントを「リアルタイムにストリーミング（継ぎ足し送信）」する技術です。
しかし、一般的な Nginx などのリバースプロキシは、パフォーマンス向上のために **「レスポンスデータをある程度バッファに溜めてから一括送信する（`proxy_buffering on`）」** のがデフォルトの挙動となっています。
このバッファリングが効いていると、MCP サーバーが送った接続開始イベントが途中で堰き止められ、クライアントにいつまでも届かないため、タイムアウトを引き起こします。

#### 【ベストプラクティスな対策 (Nginx設定)】
Nginx の MCP 用のルーティングブロックにおいて、バッファリングを完全にオフにし、タイムアウトを延長します。

```nginx
location /docker-monitor/ {
    proxy_pass http://docker-monitor-mcp:8081/;
    
    # SSE (Server-Sent Events) 用のストリーミング最適化
    proxy_buffering off;
    proxy_cache off;
    chunked_transfer_encoding on;
    
    # 接続を維持するためのタイムアウト延長 (タイムアウトによる切断を防止)
    proxy_read_timeout 24h;
    proxy_send_timeout 24h;
}
```

---

### トラブル②：同一サーバー内での https ループバック（接続拒否・ヘアピンNAT）

#### 【現象】
同居構成（同一サーバー内）であるにもかかわらず、本番を見据えて設定URLを `https://domain.com/mcp` のようにパブリックHTTPSに設定すると、接続テストがタイムアウト、またはエラーになる。

#### 【原因】
コンテナ（クライアント）から自分自身がホストされているグローバルなHTTPSアドレスにリクエストを投げると、通信がいったん外部インターネットのルーターに出てから自分自身に戻る **「ヘアピン（ループバック）接続」** が発生します。
多くのネットワーク（ファイアウォール、VPS、またはコンテナ自身のネットワークブリッジ仕様）では、このループバック通信がブロックされる、あるいはSSL証明書の解決検証（Node.js のデフォルト挙動など）で拒否されてしまうため、正常に通信できません。

#### 【ベストプラクティスな対策】

##### 解決策 [推奨]: スプリットホライズンDNS（内部ショートカット）
URLは本番・別サーバー時と同じ `https://macosui-staging.techiespod.co.jp/...` のままで、**通信経路だけを同一サーバー内で自動的に Nginx に直結（ショートカット）**させます。

Docker Compose を利用している場合、クライアントコンテナの `extra_hosts` 設定に、ホストマシンのループバックを指す `host-gateway` を追加します。

```yaml
services:
  web:
    image: macosui-web
    container_name: macosui-web
    extra_hosts:
      # ドメインへの通信を外部IPではなく、ホストマシンのポート(Nginx)に直結させる
      - "macosui-staging.techiespod.co.jp:host-gateway"
```
これにより、URLを変更することなく、内部で安全に SSL（TLS）暗号化通信を折り返して通信を成功させることができます。

---

### トラブル③：不規則なリクエストによるサーバー内部エラー（Unexpected token '<' の JSONパースエラー）

#### 【現象】
接続テスト時、フロントエンド of 画面上に、
`Connection failed: Unexpected token '<', "<!doctype "... is not valid JSON`
というエラーダイアログが突然ポップアップする。

#### 【原因】
クライアント側の実装、リバースプロキシの転送仕様、あるいはネットワークのトポロジーによって、OAuthトークン（`/oauth/token`）を POST する際の `Content-Type` ヘッダが剥がれたり、リクエストボディ（`req.body`）が空（`undefined`）で MCP サーバーに届くことがあります。

もし、MCPサーバー側の実装で、以下のように `req.body` の存在確認を怠っていると、**`TypeError: Cannot read properties of undefined`** が発生してサーバー内部でクラッシュします。

```typescript
// ❌ 脆弱なコード (req.bodyがundefinedのときにクラッシュする)
app.post('/oauth/token', (req, res) => {
    let grantType = req.body.grant_type; // ここでTypeErrorが発生！
});
```

サーバーが内部クラッシュ（500 Internal Server Error）を起こすと、Express などのフレームワークはデフォルトで **「HTML形式のエラーページ（`<!DOCTYPE html>...`）」** をクライアントに返却します。
これを受け取ったクライアント側が「JSONが返ってくる」と信じてパース（`JSON.parse()`）しようとするため、HTML の最初の文字 `<` を見て、このパースエラーを引き起こしていました。

#### 【ベストプラクティスな対策 (堅牢化)】
いかなる「壊れたリクエスト」や「ヘッダ不整合」が届いたとしても、APIサーバーは決してクラッシュ（HTML返却）せず、**常にクリーンな JSON（例: 400 Bad Request などの JSON）**を返すように安全対策（ロバストネス）を確保しなければなりません。

```typescript
//  堅牢なコード (req.bodyの存在を保証するフォールバックを設ける)
app.post('/oauth/token', express.json(), express.urlencoded({ extended: true }), (req: express.Request, res: express.Response) => {
    // req.body が undefined の場合は空オブジェクトで初期化する
    const body = req.body || {};
    
    let grantType = body.grant_type || req.query.grant_type;
    let clientId = body.client_id || req.query.client_id;
    let clientSecret = body.client_secret || req.query.client_secret;

    if (grantType !== 'client_credentials') {
        // 例外であっても、常に正しい「JSON」で応答する！
        return res.status(400).json({ error: 'unsupported_grant_type' });
    }
    // ...
});
```

---

## 3. OSS公開時のインフラチェックリスト

今後、開発した MCP サーバーをOSS（オープンソース）として世界中の開発者に提供する、あるいは社内他部門へ展開する際は、以下のチェックリストを参考に設計してください。

- [ ] **リクエストボディの徹底的な存在検証**: 
  `/oauth/token` をはじめとする POST エンドポイントでは、必ず `req.body` の null/undefined チェックを行い、いかなる場合も HTML ではなく JSON でのエラーを返却すること。
- [ ] **環境変数によるパス・プレフィックス対応**: 
  Nginx のリバースプロキシ配下（`/docker-monitor` などのサブパスルーティング）にデプロイされることを想定し、`SSEServerTransport` のメッセージ送信パス（相対URL）にプレフィックス（例: `/docker-monitor/mcp/messages`）を動的に付与できるように環境変数（`PATH_PREFIX` 等）を設けること。
- [ ] **デプロイマニュアルへのプロキシ設定の同梱**: 
  SSE を用いる特性上、Nginx や Apache、Cloudflare 等を挟む際の設定例（`proxy_buffering off;` や Cloudflare の gRPC/EventSource 有効化など）をドキュメント（README等）に明記すること。
