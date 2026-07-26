import { presetNames } from "./pty";
import WebSocket from "ws";
import { SessionManager } from "./sessionManager";
import {
  PROTOCOL_VERSION,
  type ClientToHost,
  type HostToClient,
  type HostFeatures,
  type SessionMeta,
  type RelayEnvelope,
} from "./protocol";
import {
  computeProof, deriveHostKeys, proofEquals, seal, open, b64,
  type KeyPair, type SessionKeys, type EncEnvelope,
} from "./e2ee";
import type { Pairing } from "./pairing";
import type { PushSender } from "./push";
import { listConversations, readConversation, type ConversationMeta } from "./conversations";

/**
 * ホスト側リレークライアント。アウトバウンド WSS のみでリレーに接続し(F5 のセキュリティ
 * モデル踏襲)、リレー経由でスマホクライアントと SessionManager を橋渡しする。
 * 複数セッションを sessionId で多重化(ADR-005)。自動再接続あり・E2EEなし(フェーズ1で追加)。
 *
 * 出力は「購読中のセッションのみ」クライアントへ流す(非表示セッションは PtySession の
 * scrollback に蓄積し、subscribe 時に snapshot で再送)。これで多数セッション同時でも
 * 帯域/描画の飽和を抑える(NFR-8 の基本的なバックプレッシャ)。
 */
export class RelayClient {
  private ws?: WebSocket;
  private closed = false;
  private reconnectTimer?: NodeJS.Timeout;
  // クライアントが現在購読中の sessionId。再接続でリセットされる。
  private subscribed = new Set<string>();
  private managerDisposers: Array<() => void> = [];
  // E2EE: ペアリング済みなら鍵交換後に導出した session 鍵。未確立なら undefined。
  private clientKeys?: SessionKeys;

  constructor(
    private readonly url: string,
    private readonly sessions: SessionManager,
    private readonly log: (msg: string) => void,
    private readonly room: string = "default-room",
    private readonly pairing?: Pairing,
    private readonly push?: PushSender,
    private readonly features: HostFeatures = { pty: true, agentMirror: false, agentControl: false, push: false }
  ) {}

  /** 直近に一覧化した会話。subscribe でパスを引くために持つ。 */
  private convCache: ConversationMeta[] = [];

  /**
   * エージェント会話(機能B)を読み取り専用のセッションとして一覧に混ぜる。
   *
   * pty の SessionManager には入れない。あちらは「動いているプロセス」を扱う場所で、
   * 会話は**ファイルを読むだけ**の別物だから。ここで合流させるのが結合を最小にできる。
   */
  private conversationSessions(): SessionMeta[] {
    if (!this.features.agentMirror) return [];
    try {
      this.convCache = listConversations();
    } catch {
      return [];
    }
    return this.convCache.map((c) => ({
      id: c.id,
      kind: "agent" as const,
      title: c.title,
      status: "idle" as const,
      createdAt: c.updatedAt,
      conversationId: c.id,
    }));
  }

  private findConversation(id: string): ConversationMeta | undefined {
    return this.convCache.find((c) => c.id === id);
  }

  /** ベースURLに /ws?room=&role=host を付ける。ローカル簡易リレーはパス/クエリを無視し
   *  hello でロールを判定するため、この形でも後方互換で動く。 */
  private endpoint(): string {
    const base = this.url.replace(/\/+$/, "");
    return `${base}/ws?room=${encodeURIComponent(this.room)}&role=host`;
  }

  start(): void {
    // SessionManager のイベントをクライアントへ中継
    this.managerDisposers.push(
      this.sessions.onData((sessionId, chunk) => {
        if (this.subscribed.has(sessionId)) this.toClient({ t: "output", sessionId, data: chunk });
      }),
      this.sessions.onExit((sessionId, code) => this.toClient({ t: "exit", sessionId, code })),
      this.sessions.onMeta((change) => {
        if (change.kind === "added") this.toClient({ t: "session.added", session: change.meta });
        else if (change.kind === "updated") {
          this.toClient({ t: "session.updated", session: change.meta });
          // 入力待ちになり、かつ今表示していないセッションなら push 通知(FR-5.1)
          if (change.meta.status === "waiting-input" && !this.subscribed.has(change.meta.id)) {
            void this.push?.send({
              sessionId: change.meta.id,
              title: change.meta.title,
              reason: "waiting-input",
              room: this.room,
            });
          }
        } else this.toClient({ t: "session.removed", sessionId: change.sessionId });
      })
    );
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const endpoint = this.endpoint();
    this.log(`リレーへ接続: ${endpoint}`);
    const ws = new WebSocket(endpoint, { handshakeTimeout: 10_000 });
    this.ws = ws;

    ws.on("open", () => {
      this.log("リレー接続確立");
      this.send({ t: "hello", role: "host" });
    });
    ws.on("message", (raw) => this.onMessage(raw.toString()));
    ws.on("close", () => {
      this.log("リレー切断");
      this.subscribed.clear(); // 再接続後にクライアントが再 subscribe する
      this.clientKeys = undefined; // 再接続時に鍵交換をやり直す
      this.scheduleReconnect();
    });
    ws.on("error", (err) => this.log(`リレーエラー: ${err.message}`));
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 2_000);
  }

  private onMessage(text: string): void {
    let env: RelayEnvelope;
    try {
      env = JSON.parse(text);
    } catch {
      return;
    }
    if (env.t === "peer-joined" && env.role === "client") {
      // E2EE 必須(ペアリング有)なら鍵交換完了まで挨拶しない。クリア運用のみ即挨拶。
      if (!this.pairing) this.greet();
      return;
    }
    if (env.t === "peer-left" && env.role === "client") {
      this.subscribed.clear();
      this.clientKeys = undefined;
      return;
    }
    if (env.t === "msg") this.handleIncoming(env.payload);
  }

  /** リレーから届いた payload を仕分ける: 鍵交換(clear)/ 暗号封筒 / クリアappメッセージ。 */
  private handleIncoming(payload: unknown): void {
    const p = payload as { t?: string };
    // 1) 鍵交換ハンドシェイク(常に平文)
    if (p?.t === "kx.hello") {
      this.onKxHello(payload as { pub: string; proof: string });
      return;
    }
    // 2) 暗号封筒 → 復号して app メッセージへ
    if (p?.t === "enc") {
      if (!this.clientKeys) return; // 鍵未確立
      const inner = open(this.clientKeys, payload as EncEnvelope);
      if (inner) this.handleApp(inner as ClientToHost);
      return;
    }
    // 3) 平文 app メッセージ: E2EE 必須なら拒否。クリア運用のみ許可。
    if (this.pairing) return; // ペアリング有なら平文appは無視(なりすまし防止)
    this.handleApp(payload as ClientToHost);
  }

  /** クライアントの鍵交換要求を検証し、session 鍵を導出して ack + 暗号化挨拶を返す。 */
  private onKxHello(m: { pub: string; proof: string }): void {
    if (!this.pairing) return;
    try {
      const clientPk = b64.dec(m.pub);
      const expected = computeProof(this.pairing.secret, clientPk, this.pairing.keyPair.publicKey);
      const given = b64.dec(m.proof);
      if (!proofEquals(expected, given)) {
        this.log("鍵交換: proof 不一致 → 拒否(不正なペアリング)");
        this.sendRaw({ t: "kx.reject" });
        return;
      }
      this.clientKeys = deriveHostKeys(this.pairing.keyPair, clientPk);
      this.log("鍵交換: 成立(E2EE確立)");
      this.sendRaw({ t: "kx.ack" }); // 平文。host公開鍵はQR経由で client が既知
      this.greet(); // 以後は暗号化されて送られる
    } catch (e) {
      this.log(`鍵交換エラー: ${(e as Error).message}`);
    }
  }

  /** クライアント参加/ハンドシェイク時に hello + 一覧を送る。 */
  private greet(): void {
    this.toClient({
      t: "host.hello",
      protocol: PROTOCOL_VERSION,
      features: { ...this.features, push: !!this.push, presets: presetNames() },
      vapidPublicKey: this.push?.publicKey,
    });
    this.toClient({ t: "session.list", sessions: [...this.sessions.list(), ...this.conversationSessions()] });
  }

  private handleApp(m: ClientToHost): void {
    switch (m?.t) {
      case "client.hello":
        this.greet();
        break;
      case "session.list.request":
        this.toClient({ t: "session.list", sessions: [...this.sessions.list(), ...this.conversationSessions()] });
        break;
      case "session.create":
        try {
          this.sessions.create({ preset: m.preset });
          // added メタは onMeta 経由で自動配信される
        } catch (e) {
          this.toClient({ t: "error", code: "unknown-preset", message: (e as Error).message });
        }
        break;
      case "session.close":
        if (this.findConversation(m.sessionId)) break; // 会話は閉じる対象がない
        this.sessions.close(m.sessionId);
        break;
      case "session.subscribe": {
        // 会話(読み取り専用)。pty ではないので snapshot を返して終わり。
        const conv = this.findConversation(m.sessionId);
        if (conv) {
          this.subscribed.add(m.sessionId);
          let body: string;
          try {
            body = readConversation(conv);
          } catch (e) {
            body = `(会話の読み取りに失敗しました: ${(e as Error).message})\r\n`;
          }
          this.toClient({ t: "snapshot", sessionId: m.sessionId, data: body });
          break;
        }
        if (!this.sessions.has(m.sessionId)) {
          this.toClient({ t: "error", sessionId: m.sessionId, code: "unknown-session", message: "no such session" });
          break;
        }
        this.subscribed.add(m.sessionId);
        this.toClient({ t: "snapshot", sessionId: m.sessionId, data: this.sessions.snapshot(m.sessionId) ?? "" });
        break;
      }
      case "session.unsubscribe":
        this.subscribed.delete(m.sessionId);
        break;
      case "input":
        // 会話は読み取り専用。エージェントへの送信は機能C(実験・既定オフ)であり別物。
        if (this.findConversation(m.sessionId)) break;
        this.sessions.write(m.sessionId, m.data);
        break;
      case "resize":
        this.sessions.resize(m.sessionId, m.cols, m.rows);
        break;
      case "push.subscribe":
        this.push?.setSubscription(m.subscription);
        break;
      case "push.unsubscribe":
        this.push?.setSubscription(undefined);
        break;
      // agent.* は実験機能(FR-6)。フェーズ2で agentControl 有効時に実装。
      case "agent.prompt":
      case "agent.accept":
      case "agent.reject":
        this.toClient({ t: "error", sessionId: m.sessionId, code: "feature-disabled", message: "agent control は未実装(実験機能)" });
        break;
      default:
        break;
    }
  }

  /** app メッセージをクライアントへ。E2EE 確立後は暗号封筒で送る。 */
  private toClient(msg: HostToClient): void {
    const payload = this.clientKeys ? seal(this.clientKeys, msg) : msg;
    this.send({ t: "msg", payload });
  }

  /** 平文のまま送る(鍵交換ハンドシェイク専用)。 */
  private sendRaw(payload: unknown): void {
    this.send({ t: "msg", payload });
  }

  private send(env: RelayEnvelope): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(env));
  }

  dispose(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const d of this.managerDisposers) d();
    this.ws?.close();
  }
}
