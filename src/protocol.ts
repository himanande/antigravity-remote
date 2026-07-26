// ホスト拡張 ⇄ リレー ⇄ スマホクライアント のメッセージ定義。
//
// 層は3つ:
//  1) リレー封筒(RelayEnvelope): リレーが見る唯一の層。payload は不透明で中身を解釈しない。
//     フェーズ1で payload は E2EE 暗号文になる予定(ADR-002 ゼロナレッジ)。
//  2) アプリ層(ClientToHost / HostToClient): host と client のアプリ間プロトコル。
//     v0.3 で全メッセージを sessionId で多重化(ADR-005)。
//  3) セッションメタ(Session): 一覧UIと多重化の単位。
//
// 破壊的変更を検知できるよう PROTOCOL_VERSION を持たせる。

export const PROTOCOL_VERSION = 1;

// ───────────────────────────── セッションメタ ─────────────────────────────

/** セッションの種類。pty=ホスト型ターミナル(複数並行可)、agent=Agent Manager会話。 */
export type SessionKind = "pty" | "agent";

/** セッションの状態。一覧のバッジ・通知に使う。 */
export type SessionStatus =
  | "running" // 実行中(出力が進行しうる)
  | "waiting-input" // ユーザー入力/承認待ち(通知対象)
  | "idle" // 待機(プロンプト表示など)
  | "exited"; // 終了(pty プロセス終了、または会話クローズ)

/** 一覧UIと多重化の単位。ホストが真実源として保持する。 */
export interface SessionMeta {
  id: string; // sessionId(ホストが採番、全体で一意)
  kind: SessionKind;
  title: string; // 表示名 例: "claude: ~/work/foo" / "Gemini: リファクタ相談"
  status: SessionStatus;
  createdAt: number; // epoch ms
  preset?: string; // kind=pty のとき(起動プリセット名)
  conversationId?: string; // kind=agent のとき(会話DBの <id>)
}

// ───────────────────────── Agent Manager ミラー(kind=agent) ─────────────────────────

/** 会話ステップの正規化種別([findings.md](../docs/findings.md) F2 の step_type を吸収)。 */
export type AgentStepKind = "user" | "model" | "tool" | "summary" | "unknown";

/** ミラー配信する会話ステップ1件(read-only)。抽出失敗時は kind="unknown" で劣化表示。 */
export interface AgentStep {
  seq: number; // 会話内の順序(steps テーブルの並び)
  kind: AgentStepKind;
  text: string; // 抽出テキスト(protobuf ベストエフォート)。失敗時は空
  degraded?: boolean; // true=抽出に失敗した劣化表示
}

// ───────────────────────── クライアント → ホスト ─────────────────────────

export type ClientToHost =
  // 接続直後のハンドシェイク(プロトコル版の突合)
  | { t: "client.hello"; protocol: number }
  // セッション一覧の要求(接続時・再接続時)
  | { t: "session.list.request" }
  // 新規 pty セッションの作成要求(起動はプリセットのみ=任意コマンド不可)
  | { t: "session.create"; preset: string }
  // セッションの終了/クローズ要求
  | { t: "session.close"; sessionId: string }
  // 表示開始(ホストは snapshot を返す)
  | { t: "session.subscribe"; sessionId: string }
  // 表示終了(以後そのセッションの output は不要)
  | { t: "session.unsubscribe"; sessionId: string }
  // pty へのキー入力(許可プロンプト応答もこれ)
  | { t: "input"; sessionId: string; data: string }
  // pty のリサイズ
  | { t: "resize"; sessionId: string; cols: number; rows: number }
  // Web Push 購読情報の登録/解除(ホストが入力待ち等で push を送るため)
  | { t: "push.subscribe"; subscription: PushSubscriptionJSON }
  | { t: "push.unsubscribe" }
  // ── 以下は kind=agent 用・実験的(FR-6、既定オフ。フェーズ2で有効化)──
  | { t: "agent.prompt"; sessionId: string; text: string } // プロンプト送信
  | { t: "agent.accept"; sessionId: string } // 編集/コマンドの承認
  | { t: "agent.reject"; sessionId: string }; // 却下

// ───────────────────────── ホスト → クライアント ─────────────────────────

export type HostToClient =
  // ハンドシェイク応答(プロトコル版・機能フラグ・Push用VAPID公開鍵)
  | { t: "host.hello"; protocol: number; features: HostFeatures; vapidPublicKey?: string }
  // セッション一覧の全同期
  | { t: "session.list"; sessions: SessionMeta[] }
  // 一覧の増分更新
  | { t: "session.added"; session: SessionMeta }
  | { t: "session.updated"; session: SessionMeta }
  | { t: "session.removed"; sessionId: string }
  // pty 出力チャンク
  | { t: "output"; sessionId: string; data: string }
  // subscribe/再接続時の scrollback 再送(FR-2.4, TASK-15)
  | { t: "snapshot"; sessionId: string; data: string }
  // pty 終了
  | { t: "exit"; sessionId: string; code: number }
  // ── kind=agent ミラー(read-only)──
  | { t: "agent.step"; sessionId: string; step: AgentStep }
  // エラー(機能未対応・権限・レート等)。sessionId 省略時は接続全体のエラー
  | { t: "error"; sessionId?: string; code: HostErrorCode; message: string };

/** ホストが備える機能。クライアントはこれで実験機能のUI可否を判断する。 */
export interface HostFeatures {
  pty: boolean; // ホスト型 pty(常に true)
  agentMirror: boolean; // Agent Manager 会話ミラー(B)が有効か
  agentControl: boolean; // Agent Manager 操作(C, 実験・既定オフ)が有効か
  push: boolean; // Web Push 通知が有効か(VAPID鍵が用意され送信可能)
  /** 起動を許可されたプリセット名。クライアントはこの中からしか選べない。
   *  未指定の古いホスト向けに、クライアント側は既定値へフォールバックする。 */
  presets?: string[];
}

/** Web Push 購読の JSON 表現(ブラウザ PushSubscription.toJSON())。 */
export interface PushSubscriptionJSON {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

/** push 通知の中身(service worker が受け取る)。 */
export interface PushPayload {
  sessionId: string;
  title: string; // セッション名
  reason: "waiting-input" | "exited"; // 通知理由
  room: string; // タップ時にどの room を開くか
}

export type HostErrorCode =
  | "unknown-session"
  | "unknown-preset"
  | "feature-disabled" // 実験機能が無効
  | "not-supported" // 内部コマンド不在等(NFR-7 機能検出で不可)
  | "rate-limited"
  | "internal";

// ───────────────────────────── リレー封筒 ─────────────────────────────
// リレーはこの層だけを見る。payload は不透明(将来 E2EE 暗号文)。

export type RelayEnvelope =
  | { t: "hello"; role: "host" | "client" }
  | { t: "peer-joined"; role: "host" | "client" }
  | { t: "peer-left"; role: "host" | "client" }
  | { t: "msg"; payload: unknown }; // payload = ClientToHost | HostToClient(暗号化後は不透明)

// ───────────────────────────── 型ガード補助 ─────────────────────────────

/** アプリ層メッセージから sessionId を安全に取り出す(持たない制御系は undefined)。 */
export function sessionIdOf(m: ClientToHost | HostToClient): string | undefined {
  return "sessionId" in m ? m.sessionId : undefined;
}
