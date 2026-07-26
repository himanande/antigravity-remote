# findings.md — 実地調査ログ

このファイルは「実際に環境で確認した事実」だけを記録する。推測・設計判断は書かない(それは [decisions.md](./decisions.md))。各項目に**確認日・確認方法・再現コマンド**を必ず添える。他エージェントはここを一次情報として扱ってよい。

環境: Kali Linux / Antigravity IDE **v1.107.0**(`/opt/antigravity-ide/`)。ユーザーのローカル実機で調査。

---

## F1. Antigravity は VS Code フォーク・Open VSX 配布
- 確認日: 2026-07-18
- 標準 Extension API 使用可。VSIX 手動インストール可(`antigravity --install-extension`)。マーケットプレイスは Open VSX。
- 出典: antigravity-history-keeper プロジェクトでの実測。

## F2. Agent Manager(jetski/cascade)会話DB
- 確認日: 2026-07-18(history-keeper で実測)
- 会話本体: `~/.gemini/antigravity-ide/conversations/<id>.db`(SQLite、`steps` テーブル)
- step_type: **14=ユーザー発言, 15=モデル出力, 5/8/9=ツール呼び出し, 23=会話サマリ**
- payload は**非公開 protobuf**。テキスト抽出はベストエフォートで可能。
- 成果物: `~/.gemini/antigravity-ide/brain/<id>/`
- 履歴インデックス: `~/.config/Antigravity IDE/User/globalStorage/state.vscdb`

## F3. 操作系の内部 VS Code コマンドが登録済み ★Cの格上げ根拠
- 確認日: 2026-07-18
- 確認方法: 本体バンドル `resources/app/out/vs/workbench/workbench.desktop.main.js` から識別子文字列を抽出。
- 再現:
  ```bash
  APP=/opt/antigravity-ide/Antigravity-IDE/resources/app
  grep -ohE '"antigravity[A-Za-z0-9._:-]*"' \
    $APP/out/vs/workbench/workbench.desktop.main.js | sort -u
  ```
- 確認できた操作系コマンド(抜粋):

  | コマンドID | 想定用途 |
  |---|---|
  | `antigravity.sendPromptToAgentPanel` | エージェントパネルへプロンプト送信 |
  | `antigravity.startNewConversation` | 新規会話開始 |
  | `antigravity.command.accept` / `antigravity.command.reject` | コマンド実行の承認/却下 |
  | `antigravity.prioritized.agentAcceptAllInFile` / `agentRejectAllInFile` | エージェント編集をファイル単位で承認/却下 |
  | `antigravity.prioritized.agentAcceptFocusedHunk` / `agentRejectFocusedHunk` | ハンク単位で承認/却下 |
  | `antigravity.prioritized.agentFocusNext/PreviousFile` / `...Hunk` | 対象の移動 |
  | `antigravity.openChatView` / `antigravity.openAgent` / `antigravity.agentPanel` | パネル表示 |
  | `antigravity.reloadAgentSidePanel` | サイドパネル再読込 |

- ⚠️ **未確認**: 各コマンドの**引数シグネチャ**(`executeCommand(id, ...args)` に何を渡すか)。`sendPromptToAgentPanel` が本文文字列を受けるのか、単にパネルを開くだけなのかは**未実測**。→ フェーズ0のPoCで確定する(TASK参照)。
- ⚠️ バージョン依存。v1.107.0 で確認。更新で改名・削除され得る。使用前に機能検出すること。

## F4. Agent バックエンド language_server がローカルで待受
- 確認日: 2026-07-18
- 実体: `resources/app/extensions/antigravity/bin/language_server_linux_x64`(2プロセス稼働)
  - 起動引数に `--csrf_token <uuid>` `--extension_server_port <port>` `--enable_lsp`
- `127.0.0.1` 上で複数ポートを LISTEN(実行ごとに動的、例: 37305/45629/39465/42381/34409)。外部あて `:443`(34.54.84.110)への ESTAB あり=クラウドと通信。
- 再現:
  ```bash
  ss -tlnp | grep language_server
  ps aux | grep '[l]anguage_server'
  ```
- 位置づけ: C(Agent操作)の**代替注入面**になり得る低レイヤーAPI。ただしCSRF・プロトコル非公開で非公式度が高く、**第一候補は F3 のコマンド経路**。深追いは保留。

## F5. claude.ai 公式リレーは流用不可
- 確認日: 2026-07-18(公式ドキュメント調査)
- Claude Code Remote Control のリレーは非公開API。サードパーティが自作クライアントを接続する手段なし → **自前リレー必須**。
- セキュリティモデル(踏襲する): ホストはアウトバウンドHTTPSのみ・インバウンドポートを開かない。

## F6. フェーズ0 縦切りデータ経路の疎通確認(PoC成功)
- 確認日: 2026-07-18
- 確認方法: 単一プロセスの疎通テスト `scratch-e2e.js`(リレー[relay/logic.js]+host役[bash PTY中継]+client役 を結線)。
  - 再現: `node scratch-e2e.js`(要 sandbox 無効化=PTY fork と localhost bind のため)→ `e2e-result.txt` に `PASS`。
- 結果: **client入力 → node-pty(bash) → 出力 → client の往復が成立**。TASK-03(PTYホスト)と TASK-04(リレー中継)のデータ経路を実証。
- node-pty ネイティブ: システム Node v24 向け prebuild は読み込み・spawn 成功。⚠️ **拡張ホスト(Electron 39.2.3)では ABI 不一致のため `npm run rebuild-pty` が必要**(未実施。GUI ロード確認とセットで TASK-02 の残作業)。
- esbuild バンドル+`tsc --noEmit` 通過(拡張本体のビルドは健全)。
- 発見した実装上の注意: WebSocket が OPEN になる前に送信すると `readyState 0` で例外。→ 送信は必ず readyState ガードする(本番 `RelayClient.send` は実装済み)。

## F7. 実機スマホでの往復確認(TASK-04 完了条件クリア)
- 確認日: 2026-07-18
- 構成: PC上で `node relay/server.js`(:8787、LAN IP 192.168.1.12)+ `node scratch-host.js bash`(拡張の代役=host役でPTY中継)を起動。**実機スマホのブラウザ**で `http://192.168.1.12:8787/` を開き接続(緑=接続済み)。
- 結果: **スマホ入力 → PC上の bash → 出力 → スマホ表示 の往復が実機で成立**(ユーザー確認)。v0.2 フェーズ0 完了条件①(実機往復)クリア。
- 補足: この経路は拡張のF5ロード/node-pty の Electron ABI リビルドを経ずに、システム Node の node-pty で実現(scratch-host.js)。拡張本体での動作確認(TASK-02残)と probeAgentCommands(TASK-05)は別途 GUI ロードが必要。
- 次: preset を `claude` に替えれば(`node scratch-host.js claude`)スマホから Claude Code を操作でき、完了条件②系(許可プロンプト応答→1タスク完走)を実機確認できる。

## F8. マルチセッション多重化の検証(TASK-11)
- 確認日: 2026-07-18
- 確認方法: 実モジュール(`src/sessionManager.ts` + `src/relayClient.ts` + `relay/logic.js`)を通した `scratch-multisession.ts`(esbuildで束ねて実行)。
  - 再現: `node -e "require('esbuild').build({entryPoints:['scratch-multisession.ts'],bundle:true,outfile:'scratch-multisession.js',platform:'node',format:'cjs',external:['node-pty','ws']})"` → `node scratch-multisession.js`(要 sandbox 無効)→ `e2e-result.txt` に PASS。
- 結果: bash セッション2本を同時ホストし、**(1)一覧に2件 (2)subscribe したセッションのみ出力が届く(未subscribeのs2は出力ゼロ=スコープ) (3)s1↔s2 の入出力が混線しない** を確認。
- 設計メモ: 出力は「購読中セッションのみ」中継し、非表示セッションは PtySession の scrollback に蓄積→subscribe時に snapshot 再送(NFR-8 の基本バックプレッシャ)。SessionManager が sessionId で多重化、RelayClient は購読集合を管理。

## F9. スマホUI(セッション一覧+切替)のブラウザ実証(TASK-12)
- 確認日: 2026-07-19
- 確認方法: 実スタック(relay/server.js + 実 SessionManager/RelayClient を積んだ scratch-realhost.js)を起動し、Playwright で `http://localhost:8787/`(client/index.html)を操作。
- 結果:
  - 一覧に初期セッション s1(💻 pty · 実行中)が表示。
  - 「＋ bash」タップ → `session.create` → `session.added` で一覧が **s1・s2 の2件に増加**。
  - s2 の行をタップ → 端末ビューに遷移・subscribe、`echo HELLO_S2` を入力して `HELLO_S2` 出力を確認(入力が正しいセッションへ)。
  - 「‹一覧」で一覧へ戻る。状態バッジ(実行中/入力待ち/終了/待機)描画。
  - コンソールエラーは favicon.ico の 404 のみ(無害)。
- 証跡: docs/images/task12-session-list.png / task12-s2-terminal.png

## F10. Cloudflare リレー(Workers + Durable Objects)のローカル実証(TASK-14)
- 確認日: 2026-07-19
- 確認方法: `relay-cf/` を `npx wrangler dev --port 8790 --local`(workerd ローカル)で起動し、`relay-cf/scratch-cf-test.js` で host/client を `role` クエリ接続。
  - 再現: `cd relay-cf && npm install && npx wrangler dev --port 8790 --local` → 別shell `node scratch-cf-test.js` → `cf-result.txt` に PASS。
- 結果: `/health`=200。`RelayRoom` Durable Object 経由で **peer-joined(client)→session.list→subscribe→input→output** の多重化往復を確認。DO は payload 非解釈で転送(ゼロナレッジ)。
- 実装ポイント: Hibernatable WebSockets(`state.acceptWebSocket`+`webSocketMessage/Close`)、ロールは接続時クエリ`role`で確定し `serializeAttachment` で保持、`idFromName(room)` で room→DO を決定的に集約、host 1+client N を相手ロールへブロードキャスト中継。
- 配線: ホスト(relayClient)は `<base>/ws?room=&role=host`、スマホは page URL の `?relay=&room=` を読んで `/ws?room=&role=client`。ローカル簡易リレーはパス/クエリ無視+hello 判定で後方互換(単体確認済)。
- 未検証(この環境では不可): 実デプロイ(`wrangler deploy` は Cloudflare 認証が必要)、モバイル回線からの実到達。

## F11. E2EE(ペアリング+鍵交換)の実証(TASK-13)
- 確認日: 2026-07-19
- コア正当性(Node, `scratch-e2ee-test.ts`): 鍵交換の対称性(host.tx==client.rx 等)、双方向 seal/open 一致、proof 一致/別secret拒否、改ざん封筒の復号失敗、無関係鍵での復号不能 — 全項目 PASS。
- ブラウザ↔ホスト(Playwright): 実 host(`scratch-realhost-e2ee`=RelayClient+pairing)+ローカルリレー+実 client(libsodium)で、ペアリングURL(`?relay=&room=&hpk=&ps=`)を開く → **「接続済み(E2EE)」→ 暗号チャネル越しに session.list 受信 → セッションを開き `echo E2EE_WORKS` の実行結果を確認**。証跡 docs/images/task13-e2ee-connected.png。
- libsodium ブラウザ配信: `cdn.jsdelivr.net/gh/jedisct1/libsodium.js@0.7.15/dist/browsers/sodium.js`(自己完結・onloadコールバック方式・WASM同梱)。npm の `libsodium-wrappers` の `dist/browsers/` は存在せず404だったため gh 配信を採用。
- 設計: X25519(crypto_kx)で rx/tx 導出、crypto_secretbox で認証暗号(nonce毎回ランダム)。ペアリング秘密で client の正当性を keyed-hash 証明。リレーは封筒(`t:"enc"`)を非解釈で転送=ゼロナレッジ維持。host 側は proof 不一致で `kx.reject`。
- 未確認: ブラウザ側リロード直後に libsodium 初期化が稀に遅延(CDN/キャッシュ起因の一過性、コードではない)。不正secretのブラウザUI拒否表示は kx.hello 到達前に止まり未観測だが、拒否ロジックは Node コアで実証済み。

## F12. Web Push 通知の実証(TASK-16)
- 確認日: 2026-07-20
- ホスト側連鎖(Node, `scratch-push-test.ts`): bash セッションが確認プロンプト("Do you want to proceed?")を出力 → SessionManager が既定 promptPatterns で **waiting-input 検出** → RelayClient が「非表示セッション」と判定して push 送信 → **web-push が RFC8291 暗号化 + VAPID(RFC8292)認証で push エンドポイントに POST**(偽httpsエンドポイントで捕捉: hasVapid=true, TTL=60, 暗号化本文181B)→ PASS。
  - 注意: web-push は https 必須(http だと EPROTO)。テストは自己署名証明書+`NODE_TLS_REJECT_UNAUTHORIZED=0`。
  - 再現: `node -e "...esbuild bundle scratch-push-test.ts..."` → `CERT_DIR=<certs> node scratch-push-test.js`。
- クライアント側(Playwright, push対応ホスト): `manifest.webmanifest`(200/application/manifest+json)、`sw.js`(200)配信、host.hello の push=true+vapidPublicKey で **通知ボタン表示**、`serviceWorker.register('sw.js')` が scope `/` で **登録・active** を確認。
- 設計: ホストが VAPID 鍵を globalState に永続化(pairコマンドで生成)。クライアントが push.subscribe で購読を送り、ホストが waiting-input 遷移時に該当 session を含む PushPayload を送信。SW が push で通知表示、notificationclick で該当 room を前面化。
- 未確認(実機/実push服务が必要): 実端末での購読(pushManager.subscribe)と実配信。iOS はPWAホーム追加時のみ(要案内)。VAPID公開鍵→applicationServerKey変換・許可要求はコード実装済み。

## F13. 再接続・scrollback復元(TASK-15)とキルスイッチ(FR-1.4)
- 確認日: 2026-07-20
- 再接続(`scratch-reconnect-test.ts`): client を切断→再接続すると (1)session.list が再同期し元セッションが残存 (2)subscribe で snapshot が復元し、**切断前の出力(M1)と切断中に出た出力(M2)の両方**を含む (3)セッションは実行継続 — PASS。既存機構(host が session+scrollback を保持、client が再接続時に currentId を再購読)で成立、追加実装不要。
- キルスイッチ(`scratch-kill-test.ts`): `relay.dispose()` で host が切断され、client に peer-left(host) が届いてリモート操作が断たれる — PASS。extension の killRemote コマンドは relay を dispose し pairing を破棄(既存端末を失効=FR-1.3 revoke-all 相当)、ローカルセッションは継続。再利用は「ペアリング開始」で新QR発行。
- 補足: 粒度別のデバイス失効(FR-1.3 の個別revoke)は per-connection の識別が要るため未対応(複数client同時対応と併せてフェーズ2/3)。現状は revoke-all(鍵ローテーション)で代替。

## F14. 製品化前セキュリティ対応 — room乱数化 + 依存の自己ホスト+SRI
- 確認日: 2026-07-22
- 背景: (1)room が固定既定値 "default-room" だと第三者が同じ部屋へ相乗り接続でき、中身はE2EEで読めないが妨害・DoS・課金増の温床。(2)client が xterm.js/libsodium を第三者CDN(jsdelivr)から取得しており、CDN汚染時に**暗号鍵をブラウザ内で盗まれ得る**(暗号処理がクライアント側=致命)。
- (A) room乱数化: `e2ee.ts generateRoomId()`(16バイト=128bit url-safe base64)を追加。`createPairing(room?)` は room 省略時に毎回ランダム発行。extension の startPairing は乱数roomでペアリングし、`connectRelay` は `pairing?.room ?? cfg.room` で接続roomを揃える(平文startSession時のみ設定room)。QRに room が載るのでスマホ側は自動追従(client変更不要)。package.json の room 説明を「平文ローカル用のみ」に更新。tsc --noEmit / build PASS。
- (B) 依存の自己ホスト+SRI: xterm.min.css/xterm.min.js/addon-fit.min.js/sodium.js を `client/vendor/` に取り込み、index.html を vendor 参照+`integrity="sha384-…"` に変更(同一オリジン配信で第三者CDN実行を排除、SRIで多層防御)。Cloudflare worker の Workers Static Assets が vendor/ ごと配信(dry-run で 8 files 読込確認)。
  - 検証(Playwright, `python3 -m http.server` で client配信): `window.Terminal`=function・`FitAddon.FitAddon`=有・`__sodiumReady`解決・`sodium.crypto_kx_keypair()`で32byte公開鍵 を確認。**SRI違反エラーはコンソールに無し**(WS404とfaviconのみ)。SRI改竄検知が働けばスクリプトは実行されず undefined になるが、正常ロードを確認=ハッシュ一致。
  - SRI sha384(記録): xterm.css=tStR1z… / xterm.js=J4qzUj… / addon-fit=XGqKrV… / sodium=80nH8c…(全文は index.html 参照)。バージョン更新時は再計算必須。
- 未対応(次段の任意強化): CSP メタ(script-src 'self' 等)は inline script のため要nonce化で見送り。room相乗りの接続レート制限/上限(DoS対策)はリレー側で別途。

## F15. PC⇄スマホ 双方向セッション同期(TASK-20 / Pseudoterminal)
- 実装日: 2026-07-23
- 目的: 従来はホストの node-pty が PC 画面に出ず、スマホ専用だった。**同じ node-pty を PC の VS Code ターミナルタブにもミラー**し、入力・出力を双方向同期する(PCで打つ→スマホに出る / その逆)。
- 実装: `src/terminalMirror.ts` の `TerminalMirror`。SessionManager の onMeta(added/removed)/onData/onExit に乗り、各セッションを `vscode.window.createTerminal({ pty })`(Pseudoterminal)で PC に表示。`handleInput`→`manager.write`、`setDimensions`→`manager.resize`、`close`→`manager.close`(同じptyなのでスマホ側も終了)。SessionManager は vscode 非依存を維持(結合は extension 層のみ)。extension は makeActive() で manager+mirror を同時生成、stopSession で dispose。
- 取りこぼし/重複対策: VS Code は `open()` 前の onDidWrite を破棄するため、live出力は `opened=true` 後のみ流し、open() 時に scrollback を一括再生。scrollback は pty.onData で同期更新され、open() は同期実行なので間に出力が割り込まない=取りこぼしも重複もなし。
- close ループ対策: `closing` セットで remove() 由来の close() コールバックを無視し、manager.close の二重呼びを防止。ユーザーがタブを閉じる→manager.close→removed→remove()→term.dispose→close()(closing で無視)。
- 検証状況: tsc --noEmit / build PASS。**実動作は要実機**(vscode.window.createTerminal はヘッドレス不可)。ユーザー確認項目: (1)ペアリング/新規作成で PC に「⇄ <title>」ターミナルが出る (2)PCで打つとスマホに反映、スマホで打つと PC に反映 (3)PCターミナルを閉じるとスマホ側セッションも消える (4)scrollback で履歴が両側に出る。
- 既知の制限: PC とスマホを**同時に開くと端末サイズが最後の操作側に揃う**(共有ptyは1サイズ=tmux非強制と同じ)。片側ずつ使う分は問題なし。将来 per-viewer サイズ(最小合わせ等)を検討。

## F16. node-pty 配布は「Electron ABI問題」ではなかった(TASK-21スパイク)
- 確認日: 2026-07-25
- **最重要**: node-pty 1.1.0 は **node-addon-api = Node-API(N-API)実装**(`nm -D -u build/Release/pty.node | grep -c napi_` → 40)。N-API は **ABI安定**なので、**Electron のバージョンが変わっても、Node.js でビルドしたバイナリでも同じ .node が動く**。
  - 実証: `electron-rebuild -v 39.2.3` で作った `pty.node` を素の Node v24.16.0 で `require` → 成功(`fork,open,resize,process`)。
  - 帰結: 事前検討していた「Electron世代ごとのビルドマトリクス」「起動時ABI検出→自動rebuild」は**どちらも不要**。`npm run rebuild-pty` も開発時の必須手順ではない(N-APIなので通常の `npm install` のビルドで足りる)。Antigravity が Electron を上げても**再ビルド不要で動き続ける**。
- 残る本当の課題は **plat-arch ごとのバイナリ同梱**だけ:
  - node-pty 公式 prebuilds は `darwin-arm64 / darwin-x64 / win32-arm64 / win32-x64` の4つ。**linux-* は無い**ので自前ビルドが必要。
  - `prebuilds/` は素の状態で 58MB だが、うち **53MB は Windows の `*.pdb`(デバッグシンボル)**。除外すれば全プラットフォーム合計 **5.17MB**。
  - `spawn-helper` は **macOS のみ**(binding.gyp の `OS=="mac"` 条件)。Linux は `pty.node` 単体でよい。
- 配布レイアウト: `scripts/prepare-native.js` が `dist/node_modules/node-pty/{lib,prebuilds/*}` を組み立てる。`dist/extension.js` からの `require("node-pty")` が Node の解決規則でここに当たるため、**拡張は自己完結**(利用者側のビルド不要)。node-pty 側の loader(`lib/utils.js`)は `build/Release` → `prebuilds/<plat>-<arch>` の順に探すので、`build/` を同梱しなければ prebuilds が使われる。
- 実測: `.vsix` は **2.62MB(38ファイル、5プラットフォーム同梱)**。展開して `require` → **PTY 起動成功**。`spawn-helper` の**実行ビットは .vsix 展開後も保持**されていた(`-rwxr-xr-x`)。それでも環境差を考慮し `src/pty.ts` に darwin 限定の chmod フォールバックを入れた。
- ⚠️ **Linux は必ず古い glibc のコンテナでビルドすること**: 開発機(Kali, glibc 2.42)でビルドした `pty.node` は `GLIBC_2.42` を要求し、**Ubuntu 22.04(2.35)/24.04(2.39) で動かない**(`objdump -T pty.node | grep GLIBC_` で確認)。`.github/workflows/build-vsix.yml` は `node:20-bullseye`(glibc 2.31)コンテナでビルドする。
- 再現コマンド:
  ```bash
  nm -D -u node_modules/node-pty/build/Release/pty.node | grep -c napi_   # → 40(N-API実装)
  node -e "require('./node_modules/node-pty/build/Release/pty.node')"     # Electronビルドが素のNodeで動く
  npm run package                                                         # → antigravity-remote.vsix (2.62MB)
  objdump -T vendor-prebuilds/linux-x64/pty.node | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1
  ```
- **CI実行結果(2026-07-25、run 30136849726)**: 3ジョブすべて成功。`node:20-bullseye` コンテナで作った linux-x64 / linux-arm64 は **`GLIBC_2.28` 要求**(Debian 10 / RHEL 8 相当。実質すべての現行ディストロで動く)。生成された `.vsix` は **2.91MB / 全6ターゲット同梱**(darwin×2・win32×2・linux×2)で、展開して `pty.spawn` → 起動成功。**開発機ビルドの GLIBC_2.42 問題は解消**。
- 未了: **Windows / macOS 実機での起動確認**(手元に環境が無い)。バイナリは node-pty 公式 prebuilds をそのまま同梱しているだけなので理屈上の懸念は少ないが、実機1回の確認は必要。

## F17. リレーの濫用対策(TASK-22)
- 実装日: 2026-07-25
- 脅威: リレーは**未認証**で誰でも `/ws?room=…&role=…` に繋げる。room が当たらなくても、(a)任意の room 名で **DO を無限生成**、(b)1本のソケットから**メッセージ洪水**、(c)巨大メッセージ、(d)1 room にソケットを積む、で無料枠(DO 100k req/日)を焼き切れる=**denial of wallet**。E2EEは中身を守るがこの手の消耗攻撃は防げない。
- 4層で対処:
  1. **room 形式検証**(`/^[A-Za-z0-9_\-+/=]{8,128}$/`)。長大・異常な room キーでの DO 生成を弾く。
  2. **接続レート制限**(Workers Rate Limiting binding)。**DO を作る前**の `fetch` で per-IP 60/60s・per-room 120/60s。ここを通すと DO 生成コストが発生してしまうので順序が重要。バインディング未設定時は素通り(ローカルdevを壊さない)。
  3. **room 内の同時接続上限**: host 2(再接続の重なりを許容)・client 6。超過は 429。
  4. **ソケット単位のトークンバケツ**: 300 msg/秒・バースト1200 超で `close(1008)`。メッセージ 512KB 超で `close(1009)`。**WSの受信メッセージは20通=1リクエスト課金**なので、流量制限が無いと1本のソケットで無料枠を消費し尽くせる。
- 併せてホスト側 `PtySession` の scrollback に**バイト上限 256KB** を追加。従来は「チャンク数500」だけで、1チャンクが数十KB来ると **snapshot 1通が数MB**になりリレーのサイズ上限に当たるため。
- 検証: `relay-cf/scratch-cf-limits.js`(wrangler dev --local)で **12項目すべて PASS** — 不正room 5種の400、正常roomの通過、client 6本OK/7本目429、host 2本OK/3本目429、512KB超で1009切断、洪水で1008切断、**通常の中継が壊れていないこと**。
- ⚠️ **未検証**: Rate Limiting binding は**ローカル dev では効かない**(同一IPから75接続しても全通過を実測)。per-IP/per-room の接続制限は**本番デプロイ後の確認が必要**。また同binding は**コロケーション単位・結果整合**で、正確な会計用ではない(Cloudflare公式の但し書き)。
- 既知のトレードオフ: 流量上限は「明らかな洪水」を落とす値にしてあるが、極端に高速な端末出力(`yes` 等)が長時間続くと理論上は当たりうる。恒久策はホスト側の出力コアレッシング(バックログの NFR-8)。

## F18. Workers の Rate Limiting binding は実効を確認できなかった → RateGate DO で自前実装
- 確認日: 2026-07-25
- 経緯: TASK-22 で接続レート制限に Workers の Rate Limiting binding(`[[ratelimits]]`、per-IP 60/60s)を使った。`wrangler deploy` は成功しバインディングも認識される(`env.CONN_LIMIT_IP  Rate Limit  60 requests/60s`)が、**本番で一度も発火しなかった**。
- 再現(本番): 実WebSocketアップグレード **90接続を24.8秒**で試行 → **全て open、429 はゼロ**。
  - ⚠️ 最初の検証は curl で行い全て 426 だったが、これは**テスト側の誤り**。`Upgrade: websocket` チェックがレート制限より手前にあるため、curl はレート制限に到達していなかった。**制限の検証は必ず実WSアップグレードで行うこと**。
  - 公式ドキュメントにプラン別の可否・ベータの記載はなく、原因は特定できていない(無料プラン非対応の可能性、`limit()` が例外→こちらのフォールバックで素通り、のいずれか)。
- 判断: **公開サービスの防御を、実効を実証できない機構に預けない。** `[[ratelimits]]` を外し、`RateGate` Durable Object(1 IP = 1 DO)で自前のトークンバケツを実装した。DO ならローカル `wrangler dev` でも本番でも同じ挙動を検証できる。
- 設計: 定常 20接続/分・バースト40、使い切ると60秒ブロック。**バケツの状態(tokens/ts/blockedUntil)をストレージに永続化**する。書き込むのは**許可したときだけ**なので、攻撃が続いても書き込み回数は「1分あたり20回」に自然に頭打ちになる。
- ⚠️ **最初の実装は「トークンはメモリ、ブロック時だけ永続化」にしていたが、本番で回避された。** 本番の DO は**接続の合間(1秒未満)でも退避(eviction)される**ため、リクエストごとにトークンが満タンに戻り、**ゆっくり接続する攻撃者は制限を完全に回避できた**。ローカル `wrangler dev` では DO が退避されないため**この欠陥は再現しない**。
  - 実測(修正前・本番): 並列80接続 → 43 open / 17×429(効く)。しかし**逐次**55接続 → **全て open、429ゼロ**(効かない)。この差が退避の証拠。
  - 実測(修正後・本番): 500ms間隔で120接続 → **34回目から429、通ったのは59本**。150秒で許可59本 ≒ 定常20/分の設計どおりに頭打ち。**回避は塞がれた**。
  - 教訓: **DO のメモリ上の状態は本番では毎リクエスト消えうる前提で設計する。** レート制限のように「忘れると防御が無効になる」状態は必ず永続化する。ローカル検証だけでは発見できない。
- コスト: WS接続1本あたり DO リクエストが1回増える。接続は正規利用では稀なので許容範囲。
- 検証: 本番で上記の実測に加え、通常の中継が壊れていないことも確認(host↔client 往復 PASS)。`relay-cf/scratch-cf-ratelimit.js`(wrangler dev --local)で **4項目 PASS** — バースト40本前後まで通る(実測41本目まで、42回目で429)/超過は429/ブロック中は継続拒否/**15秒待って DO 退避を誘発しても拒否が維持**(永続化の確認)。`scratch-cf-limits.js` の12項目も再実行して PASS(退行なし)。
- ⚠️ 残る限界: **多数のIP(ボットネット)からの分散接続は防げない**。1接続ごとに gate DO + room DO が作られるため。恒久策は独自ドメイン + Cloudflare WAF のレート制限ルール(workers.dev ドメインには WAF ルールを適用できない)。

## F19. 軽量テレメトリの実装と本番検証(TASK-27 / ADR-009)
- 確認日: 2026-07-26
- 実装: `StatsDay` DO(`idFromName("stats:YYYY-MM-DD")`)に**日次の集計カウンタのみ**を持つ。項目= sessions / connSeconds / msgHostToClient / msgClientToHost / bytes / rateLimited / tooLarge / roomFull。参照は `GET /stats?key=<secret>&days=N`(`STATS_KEY` 未設定なら**404で機能ごと伏せる**、比較は定数時間)。運営用に `relay-cf/check-stats.sh`。
- F18の教訓の適用:
  - 接続時刻は `serializeAttachment` に載せる(**DOの退避をまたいで保持される**)。切断時に差分から `connSeconds` を出す。
  - メッセージ数は**100件ごと + 切断時**にまとめて加算。1メッセージ1書き込みは無料枠(10万書き込み/日)を焼くため不可。
  - 拒否カウンタ `rateLimited` は「**IPがブロックに入った回数**」で、拒否リクエスト1件ごとではない。攻撃中に計測自体がコストになるのを避けるため。
- ローカル検証(`relay-cf/scratch-cf-stats.js`、wrangler dev --local): **12項目 PASS**。key なし/誤りは404・正しければ200、120件送信→**120件を正確に計上**(100件で一度flush + 切断時に端数回収)、sessions +2、connSeconds 計上、roomFull/tooLarge が各+1、**集計項目にIP/room等が混ざっていないことをキー一覧で検証**。
- **本番検証**: 実WS接続で150メッセージ送信+2接続切断 → `{"sessions":2,"connSeconds":6,"msgClientToHost":150,"bytes":6900,...}`。**取りこぼしゼロ**で計上された。
- 退行確認: `scratch-cf-limits.js` 12項目 PASS(`webSocketMessage` を async 化したが中継は集計より先に行うため影響なし)。`scratch-cf-ratelimit.js` は先行テストがトークンを消費した状態では「バースト40」が28で失敗するが、**回復を待てば41本でPASS**(テストの独立性の問題であり退行ではない)。
- ⚠️ `wrangler dev` に秘密を渡すには**シェルの環境変数では不可**。`relay-cf/.dev.vars`(gitignore済み)に書く必要がある。最初これで「key 正しいのに404」を踏んだ。
- ⚠️ Cloudflare の secret は**後から読み出せない**。`STATS_KEY` は `relay-cf/.stats-key.local`(gitignore・600)に保存してある。紛失時は `wrangler secret put STATS_KEY` で再設定する。
- プライバシー: 個票を作らないので事後の突き合わせが原理的に不可能。`PRIVACY.md` に実際のJSON例を載せ、**メッセージ数が近似であることも明記**した(正確に見せかけない)。

## F20. テスト生成物 `pairing-url.txt` が公開物(v0.2.0)に混入した
- 確認日: 2026-07-26
- 事象: `scratch-realhost-e2ee.ts` が本番リレーでの通し確認のために書き出す `pairing-url.txt` が、**git にコミットされ、`.vsix` に同梱され、Open VSX の v0.2.0 として公開された**。ファイルには**ペアリング秘密(`ps=`)とホスト公開鍵(`hpk=`)**が含まれる。
- 影響範囲(過大評価も過小評価もせず): 中身は**その場限りのテストセッション**の資格情報で、ホストプロセスは検証後に停止済み。**利用者のデータは一切含まれない**。ただし当時のハーネスは **room 名が固定(`e2ee-room`)** だったため、同じハーネスを再実行した場合に、この秘密を持つ第三者が client として先回りできる余地があった=**放置すれば将来の実害になりえた**。
- 原因: `.vscodeignore` は `scratch-*` を除外していたが、**スクリプトの出力ファイル名は `scratch-` で始まらない**。除外規則が「スクリプト」だけを見ており「スクリプトが生む成果物」を見ていなかった。
- 対処:
  1. ファイルを削除し、`.gitignore` / `.vscodeignore` に `pairing-url.txt` / `*-result.txt` / `*.local` / `*.bak.*` を追加。
  2. ハーネスの room を**毎回乱数化**(漏れた秘密が将来のセッションに適用されないようにする=根本対処)。
  3. **v0.2.1 として再公開**(Open VSX の版は不変なので 0.2.0 を差し替えることはできない)。
  4. git 履歴には残る。**テスト用の死んだ秘密であり、room乱数化で無価値化した**ため、履歴書き換え(全員の clone を壊す)は割に合わないと判断した。
- 検出方法(今後の手順に組み込む): **公開前に `.vsix` の中身を必ず一覧する**。バイナリ以外は十数ファイルしかないので目視できる。
  ```bash
  unzip -l antigravity-remote.vsix | awk '{print $4}' | grep -v "prebuilds/\|node-pty/lib/"
  ```
- 教訓: 除外規則は「置いたファイル」ではなく「**生成されるファイル**」を基準に書く。今回は実機インストール後の中身確認で偶然見つかった。**公開前チェックがなければ気づかなかった**。

## F21. ショートカット追加が実機で「反応しない」— モーダルが可視域外に出ていた(実機FB)
- 確認日: 2026-07-27(ユーザー実機フィードバック)
- 事象: 実機スマホで **キーバーの ＋(ショートカット追加)を押しても何も起きない**。Playwright(デスクトップ)では動いていたため、TASK-18 の検証時には気づけなかった。
- 原因: TASK-18 で**キーバーだけを `visualViewport` にピン留めした**が、**ボトムシート(`#modal`)はしていなかった**。ソフトキーボード表示中はレイアウトビューポートが縮まないため、`align-items:flex-end` のシートが**キーボードの裏(可視域の下)に描画**されていた。モーダルは開いていたが見えないので「反応しない」ように見えた。
  - デスクトップのブラウザではキーボードが出ないため**この不具合は再現しない**。実機でしか出ない類の欠陥。
- 対処:
  1. `applyViewport()` で `#app` と **`#modal` の両方**に height/transform を適用。
  2. `openModal()` で開く前に `document.activeElement.blur()`。端末にフォーカスが残っていると開いた直後にキーボードが出たままになるため、まず畳む。
  3. `#modal` の CSS を `inset:0` から `top/left/width/height` 形式に変更(JS の height 指定と競合しないように)。
- 検証(Playwright、390x844相当): ＋ でシートが表示され `sheetInsideViewport=true`(top 254 / bottom 560 / viewport 560)、`#modal` にピン留めのインラインstyleが付く、**追加→キーバーにボタン出現→localStorage保存→タップで送信→削除まで一巡PASS**。カスタム `gs`(`git status`)が**実際にホストで実行され出力が返った**ことも端末内容で確認。
- 併せて実装: **`clr` ボタン(画面クリア)を既定でキーバーに追加**(実機FB)。送るのは文字列 `"clear\r"` ではなく **Ctrl+L(`\x0c`)**。プロンプトでは readline が画面消去に解釈し、TUI(claude 等)で未対応でも制御文字なので**入力欄に文字が混入しない**。`clear` を打つ実装だとTUI中に文字化けする。検証: 17行→2行に消えることを確認。
- 教訓: **モバイル固有のレイアウト(ソフトキーボード)はデスクトップのPlaywrightでは検証できない。** `visualViewport` にピン留めする要素を増やしたら、**固定配置の全要素を洗い出す**。

## F22. 終了済みセッションへの resize でホストプロセスが落ちる(重大)
- 確認日: 2026-07-27
- 事象: **終了済みの PTY に `resize` を送ると node-pty が例外を投げ、ホストプロセスごと死ぬ**。
  ```
  Error: ioctl(2) failed, EBADF
      at UnixTerminal.resize → PtySession.resize → SessionManager.resize → RelayClient.handleApp
  ```
- 深刻さ: **スマホで終了済みセッションを開くだけで踏める**。クライアントは端末ビューに入るとサイズを送るため、特別な操作は要らない。拡張機能で起きれば拡張ホストが巻き添えになり、**他の生きているセッションも全部落ちる**。
- 発見経緯: プリセット追加(codex/gemini)の検証中に、**未インストールの `gemini` を選んだセッション**が即終了 → それを開いた瞬間にホストが落ちた。プリセットを増やしたことで踏みやすくなり露見したが、**バグ自体は以前から存在**していた(claude が異常終了した後に開いても同じ)。
- 対処(`src/pty.ts`): `alive` フラグ + **try/catch の両方**で守る。終了検知(onExit)と操作の間には競合があるため、フラグだけでは不十分。`write` / `resize` / `dispose` の全経路に適用。
- 検証(`scratch-deadsession-test.ts`): 5項目 PASS。**ガードを外した状態では `FAIL: ioctl(2) failed, EBADF` になることも確認**(テストが空振りしていないことの検証)。生存セッションの resize/write が従来どおり効く退行チェックも含む。
- 教訓: **外部プロセスのハンドルを触る API は、対象が死んでいる前提で常に守る。** 「終了したセッションはもう触られない」という暗黙の前提が誤りだった(UIからはいつでも開ける)。

## F23. 実機フィードバック: プリセット追加とスクロールバック
- 確認日: 2026-07-27(ユーザー実機)
- **プリセット追加**: `claude` / `bash` だけだったので `codex` / `gemini` を組み込みに追加し、さらに設定 `antigravityRemote.customPresets`(`{名前: コマンド}`)で利用者が追加できるようにした。
  - ⚠️ **許可リストはセキュリティ境界**。スマホが送れるのは preset の**名前**だけで、コマンド文字列は送れない。設定するのはホスト側(PCの持ち主)なのでこの性質は保たれる。「クライアントの文字列をそのまま spawn する」実装に変えてはならない。
  - クライアントの ＋ ボタンは**ホストが `host.hello` の `features.presets` で告知した一覧から動的生成**する。古いホスト(未告知)向けに claude/bash へフォールバック。
  - `antigravity` はIDEのGUIランチャなので**プリセットには入れていない**(PTYで起動してもGUIが立ち上がるだけで端末として使えない)。
  - 未インストールのCLIを選ぶと端末に `execvp(3) failed.: No such file or directory` が出てセッションは即終了する。分かりにくいが、原因は表示される。
- **スクロールバック**: 実機で「過去に遡れない」。xterm.js の viewport がタッチのドラッグを拾わない(テキスト選択が優先される)ため。`#term` に touch ハンドラを付け、指の移動量を行数に換算して `term.scrollLines()` を明示的に呼ぶようにした。`.xterm-viewport` に `touch-action:pan-y` も付与。scrollback は 1000→**5000行**に増量(スマホでは遡れる量が体験に直結するため)。
- 検証(Playwright、TouchEvent合成): `seq 1 200` の出力に対し下方向スワイプで `scrollTop 2832 → 2592`、表示行が 161〜188 に遡ることを確認。プリセットボタンが `＋claude / ＋codex / ＋gemini / ＋bash` と動的生成されることも確認。

---
### 追記のしかた
新しい事実を確認したら F番号を採番して追記。**必ず再現コマンドと確認日を書く**。既存項目が古くなったら「⚠️ 20xx-xx-xx時点で無効」と追記(削除しない=履歴を残す)。
