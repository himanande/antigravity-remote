# tasks.md — タスク管理・進捗共有ボード

複数エージェントの**単一の進捗共有窓口**。作業を始める前にここで担当を宣言し(status と owner を更新してコミット)、終わったら結果と根拠リンクを書く。詳しい運用は [collaboration.md](./collaboration.md)。

- **status**: `TODO` / `WIP`(着手中) / `BLOCKED` / `REVIEW`(レビュー待ち) / `DONE`
- **owner**: 空=未割当。着手時に自分のエージェント名を書く(例 `claude-fable`, `gemini`, `human:ike3`)
- **id は不変**。依存は `deps` に id で書く。完了時は `結果` 行に成果物パス/コミット/根拠を残す。

凡例: 🔴優先度高 🟡中 🟢低

---

## フェーズ0 — 縦切りPoC(目標: 遠隔操作が成立することの証明)

### TASK-01 🔴 リポジトリ初期化と開発足場
- status: DONE / owner: claude-fable / deps: —
- 内容: git init、docs 一式、拡張機能スケルトン(package.json / tsconfig / esbuild)、README。
- 結果: docs/ 一式作成。拡張スケルトンは TASK-02 で追加。

### TASK-02 🔴 拡張機能スケルトン(Antigravityで起動確認)
- status: REVIEW / owner: claude-fable / deps: TASK-01
- 内容: 最小の VS Code 拡張(activate で `console.log`+コマンド1個)を作り、Antigravity で F5 デバッグ起動 or VSIX インストールして動くことを確認。
- 進捗: 拡張スケルトン実装済み(src/extension.ts ほか)、esbuild バンドル+`tsc --noEmit` 通過(findings F6)。
- 残: **人間 or GUI操作でAntigravity上のロード確認が必要**(CLIからGUI IDEを起動できないため)。手順は docs/phase0-howto.md。node-pty の `npm run rebuild-pty`(Electron 39 ABI)も未実施。
- 完了条件: Antigravity 上で拡張のコマンドが実行できる。

### TASK-03 🔴 node-pty セッションのホスト
- status: DONE / owner: claude-fable / deps: TASK-02
- 内容: 拡張内で node-pty により PTY を起動(プリセットコマンド、まずは `bash`/`claude`)。入出力を拡張内でハンドリング。
- 結果: src/pty.ts(PtySession、scrollback保持、プリセット制)。node-pty で bash PTY を spawn し双方向I/O成立を確認(findings F6)。完了条件を満たす。

### TASK-04 🔴 簡易リレー+スマホ xterm.js クライアント(LAN内)
- status: DONE / owner: claude-fable / deps: TASK-03
- 内容: 最小 WebSocket リレー(ローカルNode or Cloudflare Tunnel)経由で、スマホブラウザの xterm.js と TASK-03 の PTY を双方向接続。E2EE/ペアリングなしでよい。
- 結果: リレー(relay/server.js+logic.js)、スマホクライアント(client/index.html)、ホスト代役(scratch-host.js)。**2026-07-18 実機スマホで往復成立を確認**(findings F7)。データ経路の完了条件クリア。
- 残(別タスク化): 完了条件の「Claude Code で1タスク完走」は preset=claude で追試 → TASK-07 へ。

### TASK-05 🔴 内部コマンド `sendPromptToAgentPanel` の引数実測
- status: TODO(コード準備済) / owner: — / deps: TASK-02
- 内容: 拡張から `vscode.commands.getCommands(true)` で `antigravity.*` の存在確認 → `executeCommand('antigravity.sendPromptToAgentPanel', <試行引数>)` を段階的に試し、**プロンプト本文が Agent Manager に届く引数形**を特定。承認系(`command.accept` 等)も併せて確認。
- 完了条件: スマホ入力を Agent Manager に届けられる(v0.2 フェーズ0 完了条件②)。結果を [findings.md](./findings.md) F3 に追記(引数仕様)。
- 進捗: 存在確認コマンド `antigravityRemote.probeAgentCommands` を実装済み(src/extension.ts、副作用なしで getCommands と突合)。実行は拡張をAntigravityにロード後(TASK-02残)。
- 注意: ⚠️ executeCommand による引数実測はユーザーの稼働中エージェントに副作用。空の会話/専用ワークスペースで検証すること。

### TASK-07 🔴 スマホから Claude Code を操作して1タスク完走(実機)
- status: TODO / owner: — / deps: TASK-04
- 内容: `node scratch-host.js claude` でホスト役を Claude Code CLI にし、スマホから許可プロンプトに応答して1タスク完走させる(v0.2 フェーズ0 完了条件②の実機確認)。
- 完了条件: スマホ操作だけで Claude Code が1タスク完了。結果を findings に追記。

### TASK-06 🟡 コスト・基盤試算(リレー選定の材料)
- status: TODO / owner: — / deps: TASK-04
- 内容: Cloudflare Workers+Durable Objects と常駐サーバ(Fly.io等)で、WSS常時接続・帯域のコストを試算。ADR-005 として decisions に起票。
- 完了条件: 数値付き比較表と推奨が decisions に載る。

---

## フェーズ1 — MVP(自分専用・マルチセッション対応)
目標: 外出先の回線から・安全に(E2EE)・複数セッションを一覧して並行操作。要件は requirements v0.3、多重化方針は decisions ADR-005。

### TASK-10 🔴 プロトコルにマルチセッション導入(sessionId+制御メッセージ)
- status: DONE / owner: claude-fable / deps: TASK-04
- 内容: src/protocol.ts を拡張。全 I/O メッセージに `sessionId`。制御メッセージ追加: `session.list`(host→client)/`session.create`(client→host, preset指定)/`session.close`/`session.subscribe`(client→host)/`session.snapshot`(host→client, scrollback)。Session メタ型(id/kind/title/status/…)を定義。
- 結果: src/protocol.ts を全面刷新。3層(RelayEnvelope不透明 / ClientToHost・HostToClient / SessionMeta)、PROTOCOL_VERSION=1、AgentStep/HostFeatures/HostErrorCode、agent.* は実験用に予約。relayClient.ts/extension.ts/client/index.html/scratch-host.js を新プロトコルに追従(単一セッション橋渡し=sessionId "main"、TASK-11で置換)。`tsc --noEmit` 通過、scratch-e2e.js で list→subscribe→input→output の多重化往復 PASS。リレー(logic.js)は payload 非解釈のまま。

### TASK-11 🔴 SessionManager(ホスト側多重化)
- status: DONE / owner: claude-fable / deps: TASK-10
- 内容: 拡張内に SessionManager を実装。複数 PtySession を id 管理、`sessions` 一覧を維持・更新、sessionId で入出力を多重化して RelayClient に流す。バックグラウンドセッションも実行継続+scrollback 保持(FR-2.6/2.7)。
- 結果: src/sessionManager.ts(create/close/write/resize/snapshot/list、onData/onExit/onMeta を sessionId 付きで通知)。RelayClient を Manager 駆動に刷新(購読集合管理、出力は購読中のみ中継、session.create/close/subscribe対応)。extension.ts に newSession コマンド追加。scratch-multisession.ts で **2本同時・一覧2件・subscribeスコープ・混線なし** を実証(findings F8)。tsc・build通過。完了条件クリア。

### TASK-12 🔴 スマホUI: セッション一覧+切替
- status: DONE / owner: claude-fable / deps: TASK-10
- 内容: client を一覧画面+個別ビューの2画面に。`session.list` を表示、タップで subscribe、新規作成(preset)、戻る。status バッジ。pty は xterm、agent は後続(TASK-2x)。
- 結果: client/index.html を2画面SPAに刷新(一覧=icon/title/kind·id/statusバッジ、増分 added/updated/removed 反映、＋claude/＋bash で session.create、行タップで subscribe→端末、‹一覧 で unsubscribe→戻る、再接続で currentId 再購読)。Playwright で 一覧2件化・切替・入力ルーティング・戻る を実証(findings F9、docs/images/)。完了条件クリア。

### TASK-13 🔴 ペアリング(QR+鍵交換)とアプリ層E2EE
- status: DONE / owner: claude-fable / deps: TASK-10
- 内容: 拡張がワンタイムQR/URL(公開鍵+有効期限)を発行、スマホで読み取り鍵交換(libsodium)。以後 payload(sessionId等の制御メタ含む)をE2EE。デバイス一覧・失効・キルスイッチ(FR-1)。
- 結果: src/e2ee.ts(X25519 crypto_kx+crypto_secretbox+ペアリングproof)、src/pairing.ts(鍵/秘密生成+QR URL組立)、extension の `pair` コマンド(QR webview表示)、RelayClient に kx ハンドシェイク+封筒暗号を統合(ペアリング有時は平文app拒否)、client にlibsodiumでclient側kx。Node コア全項目PASS+ブラウザ↔ホストで「接続済み(E2EE)」→暗号越しに session.list→echo実行を実証(findings F11、docs/images/task13-e2ee-connected.png)。
- 残(後続): デバイス一覧UI・個別失効・キルスイッチ(FR-1.3/1.4)、有効期限、複数client同時のper-connection鍵は未対応(単一client想定)。→ フェーズ2/3で拡張。
- 完了条件(コア): 未ペアリング/不正secret端末は kx.reject で操作不可、ペアリング済みのみE2EEで操作可 = 達成。

### TASK-14 🔴 クラウドリレー本実装(Cloudflare Workers + Durable Objects)
- status: REVIEW / owner: claude-fable / deps: TASK-10
- 内容: フェーズ0の簡易リレーを Cloudflare DO ベースに。テナント=1 DO に host+client 群を集約、WSS 中継、payload 非解釈(ゼロナレッジ)。再接続・複数クライアント対応。
- 結果: relay-cf/(worker.ts=fetch+RelayRoom DO、wrangler.toml、README)。Hibernatable WebSockets、room→DO集約(idFromName)、host1+clientN 中継。`wrangler dev` ローカルで多重化往復を実証(findings F10)。ホスト/スマホ/設定を room+role 配線(relayUrl+room 設定、client は ?relay=&room= を読む)。tsc・build通過。
- 残: **実デプロイ(`wrangler deploy`=Cloudflare認証が必要)とモバイル回線からの実到達確認**は人間 ike3 が実施(relay-cf/README の手順)。それが済めば DONE。
- 完了条件: 外出先回線(モバイル)からホストに到達し操作できる。

### TASK-15 🟡 再接続・scrollback 再送のマルチセッション対応
- status: DONE / owner: claude-fable / deps: TASK-11, TASK-14
- 内容: 切断→再接続時に、購読中セッションの scrollback を session.snapshot で再送。全セッションのメタも再同期。
- 結果: 既存機構で成立(host が session+scrollback 保持、client が再接続時に session.list 再同期+currentId 再購読、host が subscribe で snapshot 再送)。scratch-reconnect-test で 切断前+切断中の出力の両方が復元されることを実証(findings F13)。追加実装不要。

### TASK-17 🟡 キルスイッチ+ペアリング失効(FR-1.4 / FR-1.3 revoke-all)
- status: DONE / owner: claude-fable / deps: TASK-13
- 内容: 全リモート接続を即時遮断し、既存ペアリングを失効する。ローカルセッションは継続。
- 結果: extension の `killRemote` コマンド(relay dispose + pairing破棄、ローカル継続)。scratch-kill-test で client 切断(peer-left)を実証(F13)。粒度別の個別デバイス失効(FR-1.3)は per-connection識別が必要で未対応→revoke-all(鍵ローテーション=再ペアリング)で代替。

### TASK-16 🟡 Web Push 通知(セッション識別込み)
- status: REVIEW / owner: claude-fable / deps: TASK-12
- 内容: pty 入力待ち/agent 新規ステップで通知。どのセッションかを含める。iOS はPWAホーム追加時のみ(ガイド)。
- 結果: src/push.ts(VAPID鍵生成+web-push送信、失効処理)、SessionManager に waiting-input 検出(promptPatterns、既定はClaude Code等の確認プロンプト)、RelayClient に push トリガ(非表示セッションが入力待ち→送信)+ host.hello で VAPID公開鍵告知+push.subscribe受付、client に SW(sw.js)・manifest・通知ボタン・購読処理、extension で VAPID鍵をglobalState永続化+enablePush/promptPatterns設定。ホスト連鎖(検出→web-push暗号化POST)をNodeで実証、client の SW登録/manifest/ボタンをPlaywrightで確認(findings F12)。tsc・build通過。
- 残: **実端末での購読(pushManager.subscribe)+実配信は実push服务が必要**(人間、TASK-14デプロイと同様)。agent新規ステップ通知はフェーズ2(ミラー実装時)。
- 完了条件: バックグラウンドセッションの入力待ち→push送信まで実証済。実配信の実機確認が残。

## フェーズ2以降(バックログ)
- 会話DBウォッチャ+ミラービュー(B)を一覧に統合(history-keeper と共通ライブラリ化を検討)
- 内部コマンドブリッジ本実装(FR-6、監査ログ・レート制限)
- NFR-8: マルチセッションのバックプレッシャ/出力レート制御
- Open VSX 公開・規約整備・導入ドキュメント
- マルチホスト(複数PC)対応(フェーズ4)

---
## リリースフェーズ(TASK-21〜、ADR-006/007)
段階戦略: **Stage1=無料OSSローンチで母数獲得 → Stage2=マネージド運用**。Stage2の詳細(価格・原価・条件)は非公開ドキュメントで管理する。

### Stage 0: 公開前ブロッカー(これが無いと配れない)
- **TASK-21 [P0] node-pty配布問題の解決**: status: REVIEW / owner: claude-opus / deps: —
  - **スパイク結論(2026-07-25、F16)**: 前提が誤りだった。node-pty 1.1.0 は **Node-API(N-API)実装でABI安定**なので、**Electron世代ごとのビルドは不要**。必要なのは plat-arch ごとのバイナリ同梱のみ。Antigravity が Electron を上げても再ビルド不要。
  - 実装済: `scripts/prepare-native.js`(`dist/node_modules/node-pty` に lib+prebuilds を集約、*.pdb 53MB を除外)、`.vscodeignore`、`npm run package`、macOS spawn-helper の chmod フォールバック(`src/pty.ts`)、`.github/workflows/build-vsix.yml`。
  - 実測: **.vsix 2.62MB / darwin×2・win32×2・linux-x64 同梱**。展開して PTY 起動成功。
  - **CI完了(2026-07-25、run 30136849726)**: linux-x64/arm64 を `node:20-bullseye` でビルド → **GLIBC_2.28 要求**(実質全ディストロ対応)。CI産 `.vsix` は **2.91MB / 全6ターゲット**、展開して `pty.spawn` 成功。
  - 残(これだけ): **Windows / macOS 実機での起動確認**。node-pty公式prebuildsをそのまま同梱しているだけなので懸念は小さいが、各1回の確認は必要。
- **TASK-22 [P0] DoS/レート制限**: status: DONE / owner: claude-opus / deps: —
  - 4層で実装(F17): ①room形式検証 ②**DO生成前**の接続レート制限(Rate Limiting binding、per-IP 60/60s・per-room 120/60s) ③room内同時接続上限(host2/client6) ④ソケット単位のトークンバケツ(300msg/s・burst1200→1008切断、512KB超→1009切断)。ホスト側 scrollback にバイト上限256KBも追加。
  - 検証: `relay-cf/scratch-cf-limits.js` で **12項目 PASS**(通常の中継が壊れていないことを含む)。
  - **本番検証で Rate Limiting binding が無効と判明(F18)** → `RateGate` DO(1 IP = 1 DO、定常20/分・バースト40・超過で60秒ブロック、blockedUntil のみ永続化)に置き換え。ローカルで4項目PASS(DO退避によるリセット回避も封じたことを確認)、既存12項目も退行なし。
  - **本番検証 完了(2026-07-25)**: デプロイして実WSアップグレードで確認。初版(メモリ+ブロック時のみ永続化)は**本番のDO退避により、ゆっくり接続する攻撃で回避された**ため、バケツ状態を全て永続化する版に修正。修正後は500ms間隔120接続で34回目から429・許可59本=定常20/分どおり。通常の中継も本番でPASS。→ **DONE**
  - 残る限界(バックログ): 多数IPからの分散接続は原理的に防げない。恒久策は独自ドメイン+Cloudflare WAF(workers.dev にはWAFルールを適用できない)。
- **TASK-23 [P0] 公開整備(拡張)**: status: DONE(2026-07-25) / owner: claude-opus / deps: —
  - LICENSE(MIT)、`media/icon.png`(256/128)、README をストア掲載ページとして書き換え(英語主・日本語併記)、CHANGELOG、PRIVACY(コード実測ベース: worker はストレージ呼び出しゼロ、push subscription はPCメモリ上のみ)、package.json メタデータ(license/icon/repository/homepage/bugs/keywords/galleryBanner、publisher=himanande、v0.1.0)。
  - **GitHub 公開**: <https://github.com/himanande/antigravity-remote>(public、MIT)。事業判断(価格・原価試算・競合分析)は `business/`(gitignore)へ退避し、公開履歴に残らないよう `main` を新規履歴で開始。旧履歴はローカル `master` に保存。
  - 結果: `vsce package` **警告ゼロ**。

### Stage 1: 無料OSSローンチ
- **TASK-24 [P1] 拡張 Open VSX 公開**: status: DONE(2026-07-26) / owner: claude-opus+human:ike3
  - **公開済**: `himanande.antigravity-remote` v0.1.0(MIT)。<https://open-vsx.org/extension/himanande/antigravity-remote>
  - 配信物を検証: DL した .vsix は CI 産と同一サイズ(2,860,953B)、prebuilds 20件、README/icon/changelog/license/署名すべて配置済み。
  - つまずき記録: ①Eclipse アカウントの **GitHub Username 欄の完全一致**が必須(Publisher Agreement のボタンが出ない原因)。②`npx ovsx` が `getaddrinfo ENOTFOUND` になる場合は**実行しているシェル環境**の問題(同一マシンでも curl は通るのに Node だけ失敗した)。通常のターミナルから実行して解決。
  - 未了: 名前空間の `verified` は false(Eclipse による所有者確認を通すと true になる。機能上の制約はない)。
- **TASK-25 [P1] PWA公開品質化**: status: 大部分DONE(2026-07-26)
  - アイコン(192/512/apple-touch/favicon のPNG)を生成し、manifest を刷新(maskable含む、data URIの絵文字プレースホルダを廃止)。theme-color/description/apple-* メタ追加。SW通知にもアイコン付与。
  - ⚠️ 旧manifestは **192x192 の SVG data URI 1枚だけ**で、**TWA(Play Store)の要件を満たしていなかった**。TASK-26 の前提として先に解消した。
  - 残: 簡易オフライン(現状SWは push 専用で fetch ハンドラなし。**キャッシュを入れると更新の陳腐化リスクが出る**ので、必要性を見てから判断)。
- **TASK-26 [P1] TWA→Play Store**: Bubblewrap・**assetlinks.json**(`termhop.dev/.well-known/` に設置)・署名鍵・掲載物(説明/スクショ/プライバシー)・$25登録。TASK-25でアイコン/manifestの前提は揃済。**告知(TASK-33)より後**でよい — ストアは発見経路であって、まず記事とコミュニティの方が速い。
- **TASK-27 [P1] 軽量テレメトリ**: status: DONE(2026-07-26) / owner: claude-opus
  - **告知より先に入れる**。人が来てから「何も記録していなかった」では最初のデータを失うため。
  - 設計: 日次の集計カウンタのみを `StatsDay` DO に保持(個票なし・IP/room ID/詳細時刻は記録しない)。項目= sessions / connSeconds / msgHostToClient / msgClientToHost / bytes / 拒否カウンタ。参照は `GET /stats?key=<secret>`。
  - 実装の要点: 接続時刻は `serializeAttachment`(退避をまたいで保持)に載せる。メッセージ数は100件ごと+切断時に加算(1件1書き込みは無料枠を焼く)。**メモリ上の集計はDO退避で消えるため信用しない**([[F18]]の教訓)。
  - Analytics Engine は無料プランでの可否が不明なため不採用(ADR-009)。
  - **PRIVACY.md の同時改訂が必須**(現行の「メタデータを保持・分析しない」が不正確になる)。
  - **実装・本番検証まで完了(2026-07-26、F19)→ DONE**。ローカル12項目PASS、本番で150メッセージ→150計測(取りこぼしゼロ)。PRIVACY.md も改訂済(実際のJSON例+近似であることを明記)。運営用に `relay-cf/check-stats.sh`。
  - `STATS_KEY` は `relay-cf/.stats-key.local`(gitignore)に保存。Cloudflareのsecretは読み出せないため。

### Stage 2: マネージド運用(ユーザーが付いてから)
- TASK-28〜31。アカウント基盤・利用計測・マルチホスト・チーム/権限。**内容は非公開ロードマップで管理**(リポジトリ外)。

### Stage 1.5: 使われにいく(現在の最重要。ここが詰まると他が全部無意味)
現状(2026-07-27): Open VSX 公開済(v0.4.x、**verified 済**)、DL 730。ただし**まだ誰にも告知していない**。
リレー実績は接続258本・約15時間/日だが**ほぼ自分のテスト**。真の利用者は実質ゼロ。
**収益も上限設計も、利用者が居て初めて決められる。** よってここが唯一のボトルネック。

- **TASK-32 [P0] Windows / macOS 実機確認**(TASK-21の残)。告知の**前に**必須。
  初回起動が壊れているOSがあると、一度きりの告知機会を無駄にする。手元に環境が無いため要協力。
- **TASK-33 [P0] 告知**: status: 下書き済(2026-07-28) / owner: claude-opus
  - 下書き: `business/draft-zenn.md`(日本語・製品紹介中心)、`business/draft-reddit-en.md`(英語)。
  - ⚠️ **掲載先は r/vscode を勧めない**: 読者はほぼ Microsoft 版 VS Code 利用者で、Open VSX の拡張は手動 .vsix 導入になる。摩擦が大きく自己宣伝にも厳しい。**r/ClaudeAI / Show HN / r/selfhosted** を優先(下書きに理由と文面あり)。
  - ✅ **VS Code 実機で動作確認済(2026-07-28)**: Electron 42/Node 24.15 で同梱バイナリが動いた(F16追記)。「VS Code互換」の記述は実測に基づく。
  - 旧メモ: Zenn/note の技術記事、X、Reddit、Antigravity コミュニティ。
  訴求は「**生ターミナル × マルチセッション × 双方向同期 × エージェント非依存**」(ADR-007の差別化の芯)。
  会話閲覧(機能B)も競合が持たない要素として添える。
- **TASK-34 [P1] 実使用で出た粗さの解消**: 会話一覧の題名ノイズ(agy/Claude Code の一部)、
  未インストールCLIを選んだときの表示(`execvp(3) failed` は不親切)。

### 保留(需要次第)
- iOS App Store ラッパー(ADR-006、Apple審査・$99/年)。
- 機能C(Agent Manager への送信・承認)。機能B(閲覧)は 2026-07-27 に実装済(F28)。
  送信は内部コマンド依存で壊れやすく、競合と同じ土俵になるため、需要が見えてから判断。

### 進捗ログ(新しいものを上に)
- 2026-07-28 claude-opus: **TASK-34 の一部を先行実施(F31)**。実機で「✕は効くのに新規作成が無反応」。原因は**拡張更新→ホスト再起動→ペアリング消失**で、スマホが古いroomに繋ぎ続けていたこと。しかも**リレーが送っている peer-left をクライアントが捨てていた**ため、PCが落ちても無言だった。peer-left/joined を処理して即座に案内、ホスト不在時の＋も押した瞬間に理由を表示、kx.reject の文言も行動指示に変更。**告知の前に直すべき類の不具合**(新規利用者は拡張更新のたびに踏む)。
- 2026-07-28 claude-opus: **ペアリングし直したら会話一覧をリセット**(ユーザー要望、F30追記)。過去の会話は再開できないので一覧を占有するだけ、という判断。ペアリング時刻を基準に、それより前で止まっている会話を畳む。ただし末尾に「以前の会話 N件を表示」を残す(完全に消すと二度と辿り着けないため)。副次的に、ペアリング後に動きがあった会話は自動で現れる=稼働中のエージェントが一覧に出る。
- 2026-07-28 claude-opus: **一覧の整理機能を追加(F30)**。実機FB「過去のセッションが消せない」。調べると①『待機』は機能Bの会話24件、②**クライアントに削除UIが無かった**(session.close はあるのに導線が無い)。各行に✕を追加し、会話は**隠すだけ**(ファイルは消さない)、終了済み端末はclose、動いている端末は**2回目のタップで確定**。並び順も端末優先に変更(会話が多く端末が埋もれるため)。PWA側のみでデプロイ済、拡張の再公開は不要。
- 2026-07-27 claude-opus: **放置で接続が切れる問題を修正(F29)→ v0.4.1**。両側にキープアライブが無く、NAT/中継が無通信TCPを黙って切っていた。さらにスマホはバックグラウンドでタイマーが凍結されるため再接続タイマーも動いていなかった。クライアントは45秒ping(画面表示中のみ)+前面復帰で即再接続+指数バックオフ、ホストは30秒のpingフレーム(Cloudflare が Hibernation 中に処理するのでDOを起こさない=無課金)。途中で二重接続の回帰(Still in CONNECTING state)を作ったので、ハンドラは自分のソケットだけを見るよう修正。`wrangler deploy` で実際に全接続を切って自動復帰を確認。
- 2026-07-27 claude-opus: **機能B(エージェント会話の閲覧)実装 → v0.4.0**(F28)。Antigravity IDE / agy CLI / Claude Code の3系統を読み取り専用セッション(🤖)として一覧に合流させ、タップで本文を表示。SQLiteは**`node:sqlite`(Node標準)**で読み、ネイティブ依存を1つも増やしていない(better-sqlite3 を入れると F16 で解消したABI問題が再発するため)。本文抽出は日本語対応+ツールJSON除去の2段フィルタが必須だった。あわせて実機FBの `gemini`→`agy` 差し替え(F27)。検証: 一覧に pty1+agent24、3系統とも本文が読め、入力は無視される。
- 2026-07-27 claude-opus: **実機FB 2巡目**。①スクロールが「遡れるが滑らかでない」→ 行単位(scrollLines)の離散移動が原因。**scrollTop のピクセル1:1追従+慣性**に作り替え(150pxドラッグ=150px移動、慣性188pxを実測)。②プリセットが増えないのは**拡張ホストのプロセスが 0.2.1 を掴んだままだった**ため。0.3.0 は導入済みで、Antigravity の完全再起動で反映される。③その過程で **F26**(再起動でペアリングが切れると無言で待ち続ける)を発見し、6秒で「PCが見つかりません…」と案内するようにした。
- 2026-07-27 claude-opus: **実機FB 3件対応**。①**ホーム画面(PWA)起動で何も動かない致命バグ**(F24): manifest の start_url が `./` のためペアリングのクエリが消え、平文で別の部屋に繋ごうとしていた。localStorage に保存して復元するよう修正(ついでに history.replaceState でURLから秘密を除去)。②スクロールバックが実機で依然遡れない(F25) → touch を捕捉フェーズに変更 + 掴めるスクロールバー + **キーバーに ⤒/⤓ ボタン**を追加(タッチに依存しない確実な経路)。③プリセットが増えていなかったのは**ローカルの拡張が 0.2.1 のままだった**ため(Open VSXは0.3.0公開済)。0.3.0 をインストールして claude/codex/gemini/bash が出ることを確認。**PWA側の①②はデプロイ済みで拡張の再公開は不要**。
- 2026-07-27 claude-opus: **実機FB対応(F23)の途中で重大バグを発見・修正(F22)**。①プリセットに codex/gemini を追加し、設定 `customPresets` で利用者が追加できるように。クライアントの＋ボタンは host.hello の告知から動的生成(許可リストはセキュリティ境界なので、スマホが送れるのは名前だけという性質は維持)。②スマホでスクロールバックを遡れない問題を修正(touchハンドラで scrollLines、scrollback 1000→5000)。③**この検証中に、終了済みPTYへの resize でホストプロセスが落ちる致命バグを発見**(F22)。スマホで終了済みセッションを開くだけで踏め、拡張なら他の生きたセッションも巻き添えになる。alive フラグ+try/catch で全経路を保護し、**ガードを外すと失敗することまで確認**した回帰テストを追加。**次**: v0.3.0 として公開(拡張側の変更のため再公開が必要)。
- 2026-07-27 claude-opus: **実機FB対応(F21)**。ユーザーの実機確認で2点。①ショートカット追加の ＋ が**反応しない** → 原因は TASK-18 でキーバーだけを visualViewport にピン留めし **モーダルを忘れていた**こと。キーボード表示中にボトムシートが可視域の下に描画されていた。**デスクトップのPlaywrightでは原理的に再現しない**不具合。`#modal` もピン留め+開く前に blur で解決し、追加→送信→削除まで一巡検証。②**`clr`(画面クリア)ボタンを既定で追加**。文字列 `clear` ではなく Ctrl+L を送る(TUIで文字が混入しないため)。17行→2行を確認。**PWAはWorker配信なので拡張の再公開は不要**、デプロイのみで反映済み。
- 2026-07-26 claude-opus: **TASK-27 軽量テレメトリ DONE(設計→実装→本番検証)**。ADR-009の方針どおり日次集計のみを `StatsDay` DO に持つ形で実装。Analytics Engine は無料プランでの可否が不明なため不採用(F18の教訓)。F18の「DOのメモリ状態は消える」を設計に織り込み、接続時刻は serializeAttachment、メッセージ数は100件ごと+切断時に加算。ローカル12項目PASS(集計項目にIP/roomが混ざらないことも検証)、**本番で150メッセージ→150計測・取りこぼしゼロ**。PRIVACY.md を改訂し実JSON例と近似であることを明記。`relay-cf/check-stats.sh` で運営者が確認できる。**次**: 実機確認(ユーザー)→ TASK-26(TWA/Play Store)→ 告知。決済(TASK-28)は利用者が付くまで着手しない。
- 2026-07-26 claude-opus: **ADR-008 マネージドリレーへ転換 → ゼロ設定で使えるようになった**。独自ドメイン `termhop.dev` を取得し、apex=PWA配信 / `relay.termhop.dev`=リレー として同一Workerに割当(workers.dev の旧URLも移行期間中は維持)。拡張の既定 relayUrl を `wss://relay.termhop.dev`、clientBaseUrl を `https://termhop.dev` に変更し、既定値が機能するようになったため初回起動ガードはURL妥当性チェックに縮小。運営者になったので TERMS.md 新設 + PRIVACY.md 改訂。TASK-25のアイコン/manifestも先行実施(旧manifestはSVG data URI 1枚でTWA要件未達だった)。**本番でE2EE通し確認**: ホストを本番リレーに繋ぎ、Playwrightで termhop.dev のQR URLを開いて『接続済み(E2EE)』→ セッション選択 → `echo MANAGED_RELAY_OK` の往復まで成立。v0.2.0 として公開予定。**次**: TASK-26(TWA/Play Store)、TASK-27(軽量テレメトリで実原価計測)。
- 2026-07-26 claude-opus: **TASK-24 Open VSX 公開 DONE → Stage0/Stage1の入口を突破**。`himanande.antigravity-remote` v0.1.0 を公開し、配信物(2,860,953B・prebuilds20件・README/icon/署名)まで検証。先立って TASK-22 を本番検証し、**Cloudflare の Rate Limiting binding が本番で無効**(実WS90本でも発火せず)、さらに自前実装の初版も**本番のDO退避でゆっくり接続する攻撃に回避された**ことを実測 → バケツ状態の永続化で解決(F18)。**次の最重要論点**: 現状は利用者が自分で Cloudflare リレーを立てる必要があり、これが採用の最大の障壁。ADR-007 の無料枠(フェアユース)はマネージドリレー提供が前提なので、**Stage1でマネージドリレーを出すかの判断が必要**。
- 2026-07-25 claude-opus: **TASK-23 公開整備 DONE / GitHub公開 / CI成功で TASK-21 も実質決着**。LICENSE(MIT)・icon・README(ストア掲載版)・CHANGELOG・PRIVACY・package.jsonメタを整備し `vsce package` 警告ゼロ。公開時に課金戦略・想定収益・競合分析が晒される問題に気付き、ADR-007本文とStage2タスクを `business/`(gitignore)へ退避、`main` を新規履歴で開始(旧履歴はローカル `master`)。GitHub public 化 <https://github.com/himanande/antigravity-remote>、publisher=himanande。CI(build-vsix.yml)を実行し3ジョブ成功 → linux-x64/arm64 は **GLIBC_2.28**、**.vsix 2.91MB / 全6ターゲット**で PTY 起動確認(F16追記)。**次**: TASK-22(リレーのレート制限)→ TASK-24(Open VSX公開、要 himanande 名前空間+トークン)。TASK-21 の残は Windows/macOS 実機確認のみ。
- 2026-07-25 claude-opus: **TASK-21 スパイク完了 → 最大の技術難所は消滅**。node-pty 1.1.0 が **N-API実装でABI安定**であることを実証(electron-rebuild 産バイナリが素のNodeで動く)。よって「Electron世代マトリクス」「起動時rebuild」は不要で、plat-arch同梱だけでよい。`scripts/prepare-native.js` + `.vscodeignore` + `npm run package` で **.vsix 2.62MB(5プラットフォーム)** を生成し、展開→PTY起動まで確認。Windows prebuilds の *.pdb 53MB 除外が効いた。⚠️Linuxは公式prebuild無し&開発機ビルドは GLIBC_2.42 要求のため、`.github/workflows/build-vsix.yml`(node:20-bullseye)でCIビルドする方針(F16)。**次**: TASK-23(GitHubリポジトリ作成+repositoryフィールド+LICENSE/icon)→ CI実行 → TASK-22(レート制限)。
- 2026-07-23 claude-opus: **TASK-20 PC⇄スマホ双方向同期 実装(→要実機確認)**。src/terminalMirror.ts の TerminalMirror で、ホストの各 node-pty を VS Code Pseudoterminal として PC ターミナルタブにも表示。同じptyを両画面が見るため入力/出力が双方向同期(handleInput→write、setDimensions→resize、close→session close)。SessionManagerはvscode非依存維持、結合はextension層(makeActive で manager+mirror 生成、stopSizeで dispose)。open前live抑止+open時scrollback再生で取りこぼし/重複なし、closingガードで二重close防止。tsc/build PASS、実動作は要実機(F15)。またユーザー要望で **TASK-18 キーバーにユーザー定義ショートカット**(＋→管理シート、localStorage永続、\n/\t/\e解釈)も追加済(Playwright検証)。**次**: 実機で双方向同期の確認。その後フェーズ2(Agent Managerミラー)or 公開準備(TWA/ストア)。
- 2026-07-22 claude-opus: **実機通し確認 成功 + 製品化前セキュリティ対応 + キーバー**。①ユーザーがCloudflare実デプロイ(無料SQLite-DO)しスマホでQR→E2EE→PC操作まで到達(TASK-14実デプロイ相当クリア)。過程で worker に Workers Static Assets で client/ 同居配信を追加(1ドメイン完結、clientBaseUrl不要化)、F5用 .vscode/launch.json+tasks.json、node-pty rebuild。②ユーザーFB反映: **TASK-18 キーバー**(PWA下部に矢印/Esc/Tab/Ctrl/^C/⏎、Ctrlはトグル式で次1文字を制御コード化)を実装・Playwright検証・DONE。③**セキュリティ対応(TASK-19)**: room乱数化(generateRoomId、pairing毎に128bit)+依存の自己ホスト+SRI(xterm/libsodium を client/vendor/ に取り込み integrity付与)。tsc/build/Playwright PASS(F14)。**次**: ②既存セッション同期(Pseudoterminal で host pty を PC側ターミナルにも表示=双方向同期)=TASK-20。
- 2026-07-20 claude-fable: **TASK-15 DONE + TASK-17(キルスイッチ/失効)DONE**。再接続はscrollback復元(切断前+切断中の出力)を実証、既存機構で成立。killRemoteコマンド(全リモート遮断+ペアリング失効、ローカル継続)を追加しclient切断を実証(F13)。**フェーズ1の自律実装分は完了**。残る人間タスク: ①Cloudflare実デプロイ(TASK-14) ②実push服务での通知配信(TASK-16) ③スマホ実機でのペアリング〜操作の通し確認。次の自律作業候補: フェーズ2(Agent Managerミラー/内部コマンド操作)。
- 2026-07-20 claude-fable: **TASK-16 実装完了→REVIEW**。Web Push: src/push.ts(VAPID+web-push)、SessionManager に waiting-input 検出(promptPatterns)、RelayClient に push トリガ+VAPID告知+push.subscribe、client に SW/manifest/通知ボタン/購読、extension で VAPID永続化。ホスト連鎖(プロンプト検出→web-push暗号化POST)をNodeで実証、SW登録/manifest/ボタンをPlaywrightで確認(F12)。残は実push服务での実配信(人間)。**フェーズ1のタスク実装は一巡完了**(残: TASK-14/16の実デプロイ・実配信=人間、TASK-15再接続強化、FR-1.3/1.4 UI)。
- 2026-07-19 claude-fable: **TASK-13 DONE**。アプリ層E2EE(libsodium: X25519 crypto_kx+secretbox)+QRペアリング(pairコマンド、webviewでQR表示)。RelayClientにkxハンドシェイク+封筒暗号統合、clientにlibsodium。Nodeコア全項目PASS、Playwrightで ブラウザ↔ホスト E2EE 実チャネル(接続済み(E2EE)→暗号越しsession.list→echo実行)を実証(F11)。libsodiumは gh/jedisct1/libsodium.js@0.7.15 のonload方式ビルドを採用。**フェーズ1の主要タスク(TASK-10〜16のうちコア)完了**。残: TASK-14実デプロイ(要Cloudflare認証)、TASK-15/16(再接続強化・Web Push)、FR-1.3/1.4(デバイス失効・キルスイッチUI)。
- 2026-07-19 claude-fable: **TASK-14 実装完了→REVIEW**。relay-cf/ に Cloudflare Workers+Durable Objects リレー(RelayRoom、Hibernatable WebSockets、room→DO集約、host1+clientN中継、ゼロナレッジ)。wrangler dev ローカルで多重化往復を実証(findings F10)。ホスト/スマホ/拡張設定を room+role で配線。残は実デプロイ+モバイル実到達確認(要Cloudflare認証=人間)。**次**: TASK-13(ペアリング+E2EE)。
- 2026-07-19 claude-fable: **TASK-12 DONE**。client/index.html を「一覧↔個別ビュー」2画面SPAに刷新(状態バッジ・増分更新・session.create・subscribe/unsubscribe・再接続再購読)。Playwright で s1→＋bashでs2追加→s2で echo 実行→戻る を実証(findings F9、docs/images/task12-*.png)。**次**: TASK-13(ペアリング+E2EE)/ TASK-14(Cloudflareリレー)。UIとバックエンドの多重化は一通り動く状態。
- 2026-07-18 claude-fable: **TASK-11 DONE**。SessionManager(複数PtySessionをsessionIdで多重化、onData/onExit/onMeta通知)+ RelayClientをManager駆動に刷新(購読集合、出力は購読中セッションのみ中継=NFR-8基本バックプレッシャ)。extension に newSession コマンド追加。scratch-multisession.ts で 2本同時・一覧2件・subscribeスコープ・混線なし を実証(findings F8)。**次**: TASK-12(スマホ一覧UI)/ TASK-13(ペアリング+E2EE)/ TASK-14(Cloudflareリレー)を並行着手可能。
- 2026-07-18 claude-fable: **TASK-10 DONE**。protocol.ts を sessionId 多重化+制御メッセージ(session.list/create/close/subscribe/snapshot)+SessionMeta/AgentStep/HostFeatures に刷新(PROTOCOL_VERSION=1)。既存の relayClient/extension/client/scratch-host を新プロトコルへ追従(暫定は単一セッション sessionId="main"、TASK-11 で SessionManager に置換)。tsc通過・scratch-e2e で多重化往復 PASS。**次**: TASK-11(SessionManager で複数pty多重化)/ TASK-12(一覧UI)を並行着手可能。
- 2026-07-18 claude-fable: フェーズ1着手。要件を **v0.3 に改訂(マルチセッションを第一級要件に格上げ)**、v0.2 は superseded。ADR-005(ホスト側多重化+sessionId、リレーはセッション非解釈)を採択。フェーズ1を TASK-10〜16 に分解(protocol多重化→SessionManager→一覧UI→ペアリング/E2EE→Cloudflareリレー→再接続→通知)。推奨着手順は TASK-10→11/12 並行、TASK-13/14 は並行可能。
- 2026-07-18 claude-fable: **実機スマホで往復成立を確認、TASK-04 DONE**(findings F7)。PC上で relay/server.js + scratch-host.js(bash)を起動し、スマホブラウザ(http://192.168.1.12:8787/)から入力→PTY→出力の往復を実機検証。拡張のF5ロード不要でシステムNodeのnode-ptyで実現。残ゴール「Claude Codeで1タスク完走」は TASK-07 に切り出し(preset=claudeで追試)。
- 2026-07-18 claude-fable: フェーズ0の実装+ヘッドレス疎通確認まで完了。拡張スケルトン(src/)、リレー(relay/)、スマホクライアント(client/)を実装。scratch-e2e.js で 入力→PTY→出力→クライアント の往復を実証(findings F6)。TASK-03 DONE、TASK-02/04 は REVIEW(GUIロード・実機スマホ確認が残)。**次の人間/GUI作業**: docs/phase0-howto.md に沿って ①`npm run rebuild-pty` ②AntigravityでF5ロード ③スマホから接続確認 ④probeAgentCommands 実行 → 結果を findings F3/F6 に追記。
- 2026-07-18 claude-fable: docs 基盤(requirements v0.2 / findings / decisions / tasks / collaboration)作成。TASK-01 DONE。
