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
}

const ROLES = new Set(["host", "client"]);

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
      if (!role || !ROLES.has(role)) return new Response("invalid role", { status: 400 });
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      // room 名から決定的に DO を引く(同じ room は必ず同じ DO に集約)
      const id = env.RELAY_ROOM.idFromName(room);
      const stub = env.RELAY_ROOM.get(id);
      return stub.fetch(req);
    }

    return new Response("not found", { status: 404 });
  },
};

interface Attachment {
  role: "host" | "client";
}

/** 1 テナント(room)分の中継。host 1 + client N。 */
export class RelayRoom {
  constructor(private readonly state: DurableObjectState, _env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const role = new URL(req.url).searchParams.get("role") as "host" | "client";

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
