// Antigravity Remote クラウドリレー(Cloudflare Workers + Durable Objects)。
//
// 設計(ADR-002 / ADR-005):
//  - テナント(=ペアリング単位の room)ごとに 1 つの Durable Object(RelayRoom)へ集約。
//  - RelayRoom は host 1 本 + client N 本を保持し、msg を相手側ロールへ中継するだけ。
//    payload は不透明(将来 E2EE 暗号文)= ゼロナレッジ。
//  - ホスト/クライアントは共にアウトバウンド WSS のみ(インバウンドポートを開けない)。
//  - Hibernatable WebSockets API を使い、アイドル時に DO を休止させて費用を抑える(NFR-6)。
//
// 接続: wss://<worker>/ws?room=<id>&role=host|client
//   room = テナント識別子(TASK-13 のペアリングで確立。現状はクエリで受ける)
//   role = host | client

export interface Env {
  RELAY_ROOM: DurableObjectNamespace;
  RATE_GATE: DurableObjectNamespace;
}

const ROLES = new Set(["host", "client"]);

// room は E2EE ペアリングが発行する 16バイト乱数の base64(=22〜24文字)。
// 想定外に長い/変な文字の room を弾き、DO キーの汚染と無意味な DO 生成を防ぐ(TASK-22)。
const ROOM_RE = /^[A-Za-z0-9_\-+/=]{8,128}$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("antigravity-remote relay: ok", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/ws") {
      const room = url.searchParams.get("room");
      const role = url.searchParams.get("role");
      if (!room) return new Response("missing room", { status: 400 });
      if (!ROOM_RE.test(room)) return new Response("invalid room", { status: 400 });
      if (!role || !ROLES.has(role)) return new Response("invalid role", { status: 400 });
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }

      // 接続レート制限は **room の DO を作る前** に効かせる。ここを通してしまうと
      // 攻撃者が任意の room 名で DO を無限に生成でき、無料枠を焼き切れる。
      const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
      const gate = env.RATE_GATE.get(env.RATE_GATE.idFromName("ip:" + ip));
      const verdict = await gate.fetch("https://gate/check");
      if (verdict.status !== 200) {
        return new Response("too many connections", {
          status: 429,
          headers: { "retry-after": "60" },
        });
      }

      // room 名から決定的に DO を引く(同じ room は必ず同じ DO に集約)
      const id = env.RELAY_ROOM.idFromName(room);
      const stub = env.RELAY_ROOM.get(id);
      return stub.fetch(req);
    }

    return new Response("not found", { status: 404 });
  },
};

// --- 接続レート制限(1 IP = 1 DO)---
// Workers の Rate Limiting binding は本番で実効を確認できなかったため(F18)、
// 自前のトークンバケツで実装する。DO ならローカルでも本番でも同じ挙動を検証できる。
const GATE_PER_MIN = 20; // 定常。正規利用の再接続は1分に数回で足りる
const GATE_BURST = 40; // 瞬間的な張り直し(複数セッション同時再接続など)を吸収
const GATE_BLOCK_MS = 60_000; // 使い切ったら1分止める

/**
 * 1 IP 分の接続レート制限。
 *
 * トークンは**メモリ上**で数え、使い切ったときだけ「いつまで拒否か」を
 * **ストレージに永続化**する。こうすると、
 *  - 通常時はストレージ操作ゼロ(無料枠の書き込み上限を消費しない)
 *  - 攻撃者が間隔を空けて DO の退避(eviction)を狙っても、復帰時に
 *    blockedUntil を読み直すのでバケツのリセット逃げが効かない
 * の両立ができる。
 */
export class RateGate {
  private tokens = GATE_BURST;
  private ts = Date.now();
  private blockedUntil = 0;
  private loaded = false;

  constructor(private readonly state: DurableObjectState, _env: Env) {}

  async fetch(_req: Request): Promise<Response> {
    if (!this.loaded) {
      this.blockedUntil = (await this.state.storage.get<number>("blockedUntil")) ?? 0;
      this.loaded = true;
    }
    const now = Date.now();
    if (now < this.blockedUntil) return new Response("blocked", { status: 429 });

    this.tokens = Math.min(GATE_BURST, this.tokens + ((now - this.ts) / 60_000) * GATE_PER_MIN);
    this.ts = now;

    if (this.tokens < 1) {
      this.blockedUntil = now + GATE_BLOCK_MS;
      await this.state.storage.put("blockedUntil", this.blockedUntil);
      return new Response("blocked", { status: 429 });
    }
    this.tokens -= 1;
    return new Response("ok", { status: 200 });
  }
}

interface Attachment {
  role: "host" | "client";
}

// --- 1 room 内の上限(TASK-22)---
// host は再接続の重なりを考慮して 2 まで許す。client は同時に見る端末の想定数。
const MAX_HOSTS = 2;
const MAX_CLIENTS = 6;
// 1メッセージの上限。scrollback snapshot(ホスト側で 256KB に制限)+ E2EE/base64 の
// 膨張(約1.4倍)を通せる大きさにしてある。
const MSG_MAX_BYTES = 512 * 1024;
// 1ソケットあたりのメッセージ流量。通常の端末出力(数十/秒)を大きく上回る値にし、
// 明確な洪水だけを落とす。WSの受信メッセージは 20通=1リクエスト として課金されるため、
// ここが無いと1本のソケットで無料枠を焼き切れる。
const RATE_PER_SEC = 300;
const RATE_BURST = 1200;

interface Bucket {
  tokens: number;
  ts: number;
}

/** 1 テナント(room)分の中継。host 1 + client N。 */
export class RelayRoom {
  // ソケットごとのトークンバケツ。休止(hibernation)で消えるが、
  // 休止するのは無通信のときだけなので実害はない。
  private readonly buckets = new WeakMap<WebSocket, Bucket>();

  constructor(private readonly state: DurableObjectState, _env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const role = new URL(req.url).searchParams.get("role") as "host" | "client";

    // room あたりの同時接続数を制限する。ここを開けておくと、1つの room に
    // ソケットを積み上げるだけで DO のメモリと中継コストを増やせてしまう。
    const limit = role === "host" ? MAX_HOSTS : MAX_CLIENTS;
    if (this.state.getWebSockets(role).length >= limit) {
      return new Response("room is full", { status: 429, headers: { "retry-after": "30" } });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernation 対応で accept。role は attachment に載せて休止をまたいで保持する。
    this.state.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role } satisfies Attachment);

    // 参加を相手ロールへ通知(host は peer-joined(client) を受けて挨拶する)
    this.notifyPeers(server, role, { t: "peer-joined", role });

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return; // 本プロトコルは JSON テキストのみ
    if (message.length > MSG_MAX_BYTES) {
      ws.close(1009, "message too large");
      return;
    }
    if (!this.consumeToken(ws)) {
      ws.close(1008, "rate limit exceeded");
      return;
    }
    let env: { t?: string };
    try {
      env = JSON.parse(message);
    } catch {
      return;
    }
    // hello はローカルリレー互換のため受けるが、role は既に確定済みなので無視でよい。
    if (env.t === "hello") return;
    if (env.t !== "msg") return;

    const self = this.roleOf(ws);
    if (!self) return;
    // 相手ロールへそのまま中継(payload は解釈しない)
    const targetRole = self === "host" ? "client" : "host";
    for (const peer of this.state.getWebSockets(targetRole)) {
      trySend(peer, message);
    }
  }

  webSocketClose(ws: WebSocket): void {
    const role = this.roleOf(ws);
    if (role) this.notifyPeers(ws, role, { t: "peer-left", role });
  }

  webSocketError(ws: WebSocket): void {
    const role = this.roleOf(ws);
    if (role) this.notifyPeers(ws, role, { t: "peer-left", role });
  }

  /** トークンバケツ。1秒あたり RATE_PER_SEC 回復、上限 RATE_BURST。 */
  private consumeToken(ws: WebSocket): boolean {
    const now = Date.now();
    let b = this.buckets.get(ws);
    if (!b) {
      b = { tokens: RATE_BURST, ts: now };
      this.buckets.set(ws, b);
    }
    b.tokens = Math.min(RATE_BURST, b.tokens + ((now - b.ts) / 1000) * RATE_PER_SEC);
    b.ts = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private roleOf(ws: WebSocket): "host" | "client" | undefined {
    const att = ws.deserializeAttachment() as Attachment | null;
    return att?.role;
  }

  /** 自分以外の全ソケットのうち、相手ロールへ通知を送る。 */
  private notifyPeers(self: WebSocket, selfRole: "host" | "client", msg: unknown): void {
    const targetRole = selfRole === "host" ? "client" : "host";
    const text = JSON.stringify(msg);
    for (const peer of this.state.getWebSockets(targetRole)) {
      if (peer !== self) trySend(peer, text);
    }
  }
}

function trySend(ws: WebSocket, data: string): void {
  try {
    ws.send(data);
  } catch {
    /* peer closing */
  }
}
