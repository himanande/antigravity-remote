# Antigravity Remote — クラウドリレー(Cloudflare Workers + Durable Objects)

ホスト拡張とスマホPWAを仲介するゼロナレッジ中継。テナント(`room`)ごとに1つの Durable Object(`RelayRoom`)へ集約し、`msg` を相手ロールへそのまま転送するだけ(payload は不透明=将来E2EE)。ホスト/クライアントとも**アウトバウンドWSSのみ**。

## エンドポイント
- `GET /health` → `ok`(疎通確認)
- `GET /ws?room=<id>&role=host|client`(WebSocket昇格)
  - 同じ `room` は必ず同じ DO に集まる(`idFromName(room)`)
  - `role=host` は1本想定、`role=client` はN本可(host→全client、client→host に中継)

## ローカル実行(デプロイ不要)
```bash
cd relay-cf
npm install
npx wrangler dev --port 8790 --local
# 別ターミナルで疎通テスト(host/client 往復)
node scratch-cf-test.js   # → cf-result.txt に PASS
```

## デプロイ
```bash
npx wrangler login          # 初回のみ(ブラウザ認証)
npx wrangler deploy         # wss://antigravity-remote-relay.<subdomain>.workers.dev
```
デプロイ後、ホスト拡張の設定 `antigravityRemote.relayUrl` を `wss://<worker>.workers.dev` に、
スマホは `https://<clientの配信先>/?relay=wss://<worker>.workers.dev&room=<id>` で開く
(この `relay`/`room` は TASK-13 のペアリングQRが自動で埋める予定)。

## 設計メモ
- **Hibernatable WebSockets**: `state.acceptWebSocket()` + `webSocketMessage/Close` を使い、
  アイドル時に DO を休止させて費用を抑える(NFR-6)。ロールは `serializeAttachment` で休止をまたいで保持。
- **ゼロナレッジ**: DO は `t:"msg"` の payload を一切解釈せず転送するのみ(ADR-002)。
- **room = テナント境界**: DO 単位で完全分離。将来の課金/マルチテナントもこの単位(FR-7.2)。
- 検証: `wrangler dev`(workerd ローカル)で peer-joined→list→subscribe→input→output の
  多重化往復を確認(findings F10)。

## 未対応(後続)
- 認証: 現状 `room` を知っていれば接続できる。TASK-13 のペアリング(鍵交換)で正当性を担保する。
- レート制限・接続数上限(FR-7.2 / NFR-2)。
- E2EE は端点(ホスト/クライアント)側で被せる。リレーは不透明転送のままでよい。
