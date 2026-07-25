# Antigravity Remote — 要件定義書 v0.1

- 作成日: 2026-07-18
- ステータス: ドラフト(フェーズ0着手前)
- 対象: Google Antigravity IDE 用 VS Code 互換拡張機能+リレーサーバ+スマホ向けWebクライアント

---

## 1. 背景と目的

Claude Code には、ローカルで動くセッションを外出先のスマホ・ブラウザから継続操作できる **Remote Control** 機能がある(アウトバウンドHTTPSのみでリレーサーバに接続し、claude.ai/code やモバイルアプリから操作する構成)。

Antigravity IDE にはこれに相当する機能がない。本プロジェクトは、**Antigravity 上のエージェント作業を、外出先のスマホのブラウザから閲覧・継続・操作できる機能**を拡張機能として実現し、最終的に一般公開(プロダクト化)することを目的とする。

## 2. 用語

| 用語 | 意味 |
|---|---|
| ホスト | Antigravity が動作するローカルマシン+本拡張機能 |
| リモートクライアント | スマホ等のブラウザで開く操作用 Web UI(PWA) |
| リレー | ホストとリモートクライアントを仲介するクラウドサーバ。両者ともアウトバウンド接続のみ |
| Agent Manager | Antigravity 標準の Gemini エージェント機能(公開APIなし) |
| ホスト型セッション | 本拡張機能が node-pty 等で自前にホストするターミナルセッション(Claude Code CLI 等を実行) |

## 3. 実現可能性調査の結果(要件の前提)

### 3.1 確定事項

| # | 事実 | 根拠 |
|---|---|---|
| F1 | Antigravity は VS Code フォークで、標準 Extension API が使える。配布は Open VSX(VSIX手動インストールも可) | antigravity-history-keeper プロジェクトで実測済み |
| F2 | Agent Manager(Gemini)の会話は `~/.gemini/antigravity-ide/conversations/<id>.db`(SQLite)に保存され、テキスト抽出可能(payload は非公開 protobuf、ベストエフォート) | 同上(step_type: 14=ユーザー, 15=モデル, 5/8/9=ツール, 23=サマリ) |
| F3 | Claude Code Remote Control のリレー(claude.ai 側)は非公開APIであり、サードパーティが自作クライアントを接続する手段はない | 公式ドキュメント調査 |
| F4 | Claude Code Remote Control のセキュリティモデルは「ホストはアウトバウンドHTTPSのみ・インバウンドポートを開かない」。本プロジェクトも同モデルを踏襲する | 公式ドキュメント調査 |

### 3.2 機能別の実現可能性判定

| 対象 | 判定 | 方式 |
|---|---|---|
| ホスト型セッション(Claude Code 等の CLI)の遠隔操作 | ◎ 実現可能 | 拡張機能内で node-pty によりターミナルをホストし、入出力をリレー経由で中継。標準技術のみで完結 |
| Agent Manager の会話の**閲覧**(read-only ミラー) | ○ 実現可能・非公式 | F2 の SQLite を監視・差分抽出してリモートに配信。スキーマ変更で壊れうるためベストエフォート扱い |
| Agent Manager への**入力送信・承認操作** | ✕ 現状不可 | 公開API/CLIが存在しない。DB書き込みは破損リスクが高く採用しない。Antigravity が公式APIを出した時点で対応(将来要件) |
| claude.ai 公式リレーの流用 | ✕ 不可 | F3。**自前リレーの構築が必須**(一般公開の主コスト要因) |

**結論: 実現可能。** ただし製品の核は「ホスト型セッションの遠隔操作」+「Agent Manager の読み取り専用ミラー」の2本柱とし、Agent Manager の操作はスコープ外とする。

## 4. スコープ

### 4.1 スコープ内(MVP)

1. **ペアリング**: 拡張機能が QR コード/URL を発行し、スマホで読み取ってホストと安全に紐付け
2. **ホスト型セッションの遠隔操作**: スマホからターミナル(Claude Code CLI 等)への入力・出力閲覧・許可プロンプトへの応答
3. **Agent Manager 会話ミラー**: 進行中の Gemini エージェント会話を読み取り専用でスマホに表示(閲覧のみと明示)
4. **セッション一覧**: ホスト上のセッションを一覧し、切替・新規作成・終了
5. **通知**: エージェントが入力待ち・完了になったら Web Push で通知

### 4.2 スコープ外

- Agent Manager への入力・承認(公式API待ち。v2以降の検討事項)
- スマホネイティブアプリ(PWAで代替)
- 画面共有型のリモートデスクトップ(テキスト/構造化データの中継のみ)
- Antigravity 以外の IDE 対応(VS Code 本家対応は技術的にほぼ無償で得られるため、公開時のオプションとして検討)

## 5. システム構成

```
[Antigravity IDE]                     [クラウド]                [スマホ]
 拡張機能 (ホスト)  ──outbound WSS──▶  リレーサーバ  ◀──WSS──  PWA (ブラウザ)
  ├ node-pty セッション管理            ├ ペアリング仲介          ├ ターミナルUI(xterm.js)
  ├ 会話DBウォッチャ(read-only)        ├ メッセージ中継          ├ 会話ミラービュー
  └ E2EE 暗号化端点                    │  (E2EEのため内容は       └ E2EE 暗号化端点
                                       │   復号できない=          
                                       └   ゼロナレッジ)          
```

- ホスト・クライアントとも**アウトバウンド接続のみ**。ホスト側にポートを開けない(F4 踏襲)
- リレーは中継専用。**E2EE(エンドツーエンド暗号化)によりリレー運営者はセッション内容を読めない**設計とする(一般公開プロダクトとしての信頼性の核)

### 技術スタック(想定)

| コンポーネント | 技術 |
|---|---|
| 拡張機能 | TypeScript / VS Code Extension API / node-pty / better-sqlite3(read-only) |
| リレー | Cloudflare Workers + Durable Objects(WebSocket 中継、低運用コスト)※Fly.io 等の常駐サーバと比較検討 |
| クライアント | PWA(TypeScript、xterm.js、Web Push、Service Worker) |
| E2EE | ペアリング時に鍵交換(QR に公開鍵を含める)、libsodium 等 |

## 6. 機能要件

### FR-1 ペアリング・認証
- FR-1.1 拡張機能はワンタイムのペアリングQR/URL(有効期限付き)を発行できる
- FR-1.2 ペアリング時に鍵交換を行い、以後の通信は E2EE とする
- FR-1.3 ペアリング済みデバイスの一覧表示・個別失効(revoke)が拡張機能側からできる
- FR-1.4 ホスト側から全リモート接続を即時遮断できる(キルスイッチ)

### FR-2 ホスト型セッション遠隔操作
- FR-2.1 リモートから新規ターミナルセッションを作成できる(起動コマンドは拡張設定で定義したプリセットのみ。任意コマンド起動は不可)
- FR-2.2 セッションの入出力をリアルタイムに双方向中継する(目標レイテンシ: 体感1秒未満)
- FR-2.3 Claude Code の許可プロンプト等にスマホから応答できる(通常のキー入力中継で成立)
- FR-2.4 切断・再接続時にセッションは維持され、直近の出力バッファ(スクロールバック)を再送する
- FR-2.5 IDE 側のターミナルビューでも同一セッションを閲覧できる(デスクに戻ったら続きから)

### FR-3 Agent Manager 会話ミラー(read-only)
- FR-3.1 会話DBを監視し、新規ステップを抽出してリモートに差分配信する
- FR-3.2 ユーザー発言/モデル出力/ツール呼び出し/サマリを区別して表示する
- FR-3.3 抽出失敗時は「表示できないステップ」として劣化表示し、機能全体は落とさない(protobuf 非公開のため)
- FR-3.4 UI 上で「閲覧のみ・操作不可」を明示する

### FR-4 通知
- FR-4.1 ホスト型セッションが入力待ちになったら Web Push 通知
- FR-4.2 Agent Manager 会話に新規ステップが出たら通知(オン/オフ可)

### FR-5 一般公開・運用(プロダクト要件)
- FR-5.1 Open VSX で拡張機能を公開する(VS Code Marketplace は Antigravity から使えないため主戦場は Open VSX)
- FR-5.2 リレーはマルチテナントで、テナント間は暗号レベルで分離される(E2EE により漏洩してもリレー側に平文がない)
- FR-5.3 匿名利用を基本とし、アカウント登録なしで使い始められる(課金導入時に再検討)
- FR-5.4 利用規約・プライバシーポリシーを用意し、「Agent Manager ミラーは非公式機能でありAntigravityの更新で停止しうる」ことを明記する

## 7. 非機能要件

| # | 要件 |
|---|---|
| NFR-1 | セキュリティ: E2EE 必須。リレーに平文を置かない。ホストはアウトバウンド接続のみ |
| NFR-2 | セキュリティ: リモートからのコマンド実行面を最小化(FR-2.1 のプリセット制)。将来もリモートに与える能力は「ターミナル入力」を超えない |
| NFR-3 | 可用性: リレー障害時、ローカルの作業は一切影響を受けない(拡張はリレー無しでも無害に動作) |
| NFR-4 | プライバシー: 会話DB の内容をホスト外に送るのはミラー機能を明示的に有効化した場合のみ。デフォルトはオフ |
| NFR-5 | 性能: ホスト側常駐処理(DB監視)は Antigravity の動作を阻害しない(ポーリング間隔・WALモード read-only) |
| NFR-6 | コスト: 個人開発で維持可能なリレー運用費(従量課金型サーバレスを第一候補とする所以) |

## 8. リスクと対応

| リスク | 影響 | 対応 |
|---|---|---|
| Antigravity の DB スキーマ変更でミラーが壊れる | 中 | ミラーはベストエフォート機能と位置付け(FR-3.3, FR-5.4)。コア価値はホスト型セッションに置く |
| 内部DB読み取りの規約上のグレーさ(一般公開時) | 中〜高 | read-only 徹底・ローカル処理・明示オプトイン。公開前に Antigravity の利用規約を精査し、必要ならミラー機能を「実験的」フラグに隔離 |
| Anthropic/Google が公式に同等機能を出す | 高 | Claude Code 単体は既に Remote Control がある。本製品の差別化は「Antigravity(≒IDE内の複数セッション+Gemini会話)をまとめて見られる」点に置く |
| リレーの悪用(不正中継・DoS) | 中 | ペアリング必須・レート制限・接続数上限。E2EE により踏み台価値を下げる |
| Web Push が iOS Safari で制約あり | 低 | PWA をホーム画面追加した場合のみ通知可(iOS 16.4+)。セットアップガイドで案内 |

## 9. フェーズ計画

| フェーズ | 内容 | 完了条件 |
|---|---|---|
| **0. 縦切り PoC** | 拡張機能で node-pty セッションをホストし、簡易リレー(手元の WS サーバ or Cloudflare Tunnel)経由でスマホブラウザの xterm.js から Claude Code を操作できることを確認。E2EE・ペアリングは未実装でよい(自分のLAN内) | スマホから許可プロンプトに応答して1タスク完走 |
| 1. MVP(自分専用) | ペアリング(QR+E2EE)、Cloudflare 上のリレー、セッション一覧、再接続、Web Push | 外出先の回線から常用できる |
| 2. ミラー機能 | 会話DBウォッチャ+ミラービュー(history-keeper の抽出コードを流用) | Gemini 会話がスマホで追える |
| 3. 一般公開 | マルチテナント化、規約整備、Open VSX 公開、セットアップドキュメント | 第三者がドキュメントだけで導入できる |
| 4. 検討 | 課金、チーム利用、Agent Manager 公式API対応(出れば) | — |

## 10. 未決事項

- リレー基盤の最終選定(Cloudflare Durable Objects vs 常駐サーバ)→ フェーズ0の結果とコスト試算で決定
- プロダクト名(仮: Antigravity Remote)
- ミラー抽出コードを history-keeper と共通ライブラリ化するか(両プロジェクトで protobuf 抽出を使うため、共通化が有力)

## 参考資料

- [Claude Code Remote Control 公式ドキュメント(日本語)](https://code.claude.com/docs/ja/remote-control)
- [DevelopersIO: Remote Control でスマホからローカルマシンの作業を継続可能に](https://dev.classmethod.jp/articles/claude-coderemotecontrol-enables-you-to-work-on-your-local-machine-from-your-smartphone/)
- [Zenn: Claude Code Remote Control が登場](https://zenn.dev/ubie_dev/articles/claude-code-remote-control-intro)
- [Antigravity への拡張機能インストール方法(Open VSX / VSIX)](https://medium.com/@agurindapalli/how-to-install-vs-code-marketplace-extensions-in-googles-antigravity-ide-example-deepblue-theme-689cdcd735eb)
- 兄弟プロジェクト: `~/work/projects/antigravity-history-keeper/docs/requirements_v0.1.md`(会話DB構造の実測結果)
