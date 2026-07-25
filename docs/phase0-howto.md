# フェーズ0 実機確認 手順書

コード実装とヘッドレス疎通確認(findings F6)は完了済み。ここに残るのは **GUI(Antigravity)操作と実機スマホが必要な確認**。CLIからGUI IDEを起動できないため、この手順は人間 ike3 か、GUIを操作できるエージェントが実施する。

前提: リポジトリ直下で `npm install` 済み。同一LAN上にPCとスマホがある。

## 1. node-pty を Electron ABI 向けにリビルド
拡張ホストは Antigravity(Electron 39.2.3)で動くため、node-pty をその ABI 向けに再ビルドする。
```bash
cd ~/work/projects/antigravity-remote
npm run rebuild-pty        # electron-rebuild -v 39.2.3 -m ./ -w node-pty
npm run build              # dist/extension.js を生成
```
> 失敗時は Electron のバージョンを Antigravity の `resources/app/package.json` の `electron` 値で確認して `-v` を合わせる。

## 2. 簡易リレーを起動(PC上)
```bash
node relay/server.js       # 既定 http://0.0.0.0:8787(client UI + ws を同居配信)
```
PCのLAN IPを控える(例 `ip addr` で `192.168.x.x`)。

## 3. Antigravity に拡張をロード
- 方法A(デバッグ起動): Antigravity でこのフォルダを開き、`F5`(Run Extension)。拡張開発ホストが立ち上がる。
- 方法B(VSIX): `npm run package` → 生成された `antigravity-remote.vsix` を「Extensions: Install from VSIX...」でインストール。
- 設定を確認: `antigravityRemote.relayUrl` = `ws://localhost:8787`、`antigravityRemote.sessionPreset` = `claude`(または `bash`)。

## 4. ホスト型セッションを開始
コマンドパレット → **「Antigravity Remote: ホスト型セッションを開始してリレーに接続」**。出力パネル「Antigravity Remote」に「リレー接続確立」が出ればOK。

## 5. スマホから接続(TASK-04 完了条件)
スマホのブラウザで `http://<PCのLAN IP>:8787/` を開く。xterm.js の画面が出て、上部ドットが緑=接続済み。
- **確認**: スマホでコマンドを打ち、PC側セッションで実行され出力が返ること。
- **完了条件**: Claude Code の許可プロンプトにスマホから応答して1タスク完走。
- 済んだら [findings.md](./findings.md) に「実機往復OK/確認日」を追記し、tasks.md の TASK-04 を DONE に。

## 6. 内部エージェントコマンドの存在確認(TASK-05 第一段)
コマンドパレット → **「Antigravity Remote: 内部エージェントコマンドを検出(TASK-05)」**。出力パネルに各 `antigravity.*` の存在/非存在が並ぶ。
- 結果(何個存在したか、どれが無いか)を [findings.md](./findings.md) F3 に確認日付きで追記。
- ⚠️ **次段(引数実測)は副作用あり**。`antigravity.sendPromptToAgentPanel` に実際に引数を渡す検証は、**空の会話・使い捨てワークスペース**で行うこと(collaboration.md の安全ルール)。この存在確認コマンドは executeCommand を呼ばないので安全。

## トラブルシュート
- `node-pty の読み込みに失敗`: 手順1のリビルド未実施。ABI不一致。
- スマホで真っ白/xtermが出ない: スマホがCDN(jsdelivr)に到達できるネットワークか確認(フェーズ0はxtermをCDN参照)。フェーズ1でバンドルに置換予定。
- 緑にならない: リレー未起動、URL/ポート違い、PCのファイアウォールで8787が塞がれている、など。
