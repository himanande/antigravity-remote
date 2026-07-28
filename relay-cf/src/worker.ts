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
  STATS: DurableObjectNamespace;
  /** /stats 参照用の共有秘密。未設定なら /stats は 404 を返す(=機能ごと無効)。 */
  STATS_KEY?: string;
}

// --- 軽量テレメトリ(TASK-27 / ADR-009)---
// 記録するのは **UTCの日ごとの集計値だけ**。個票(1接続ごとの記録)は作らないので、
// 後から特定の人やセッションを辿ることが原理的にできない。IP・room ID・日より
// 細かい時刻・ペイロードは一切保存しない。
interface Counters {
  /** 切断まで到達した接続の本数 */
  sessions: number;
  /** 合計接続秒数 */
  connSeconds: number;
  msgHostToClient: number;
  msgClientToHost: number;
  /** 中継バイト数(JSON文字列長の合計。概算) */
  bytes: number;
  /** IP がレート制限でブロックされた**回数**(拒否リクエスト数ではない) */
  rateLimited: number;
  /** サイズ超過で切断した回数 */
  tooLarge: number;
  /** 満室で接続を断った回数 */
  roomFull: number;
}

/** 1日あたりの重複しない設置数の上限(異常時に無制限に膨らませない)。 */
const MAX_HOSTS_TRACKED = 20_000;

const COUNTER_KEYS: (keyof Counters)[] = [
  "sessions",
  "connSeconds",
  "msgHostToClient",
  "msgClientToHost",
  "bytes",
  "rateLimited",
  "tooLarge",
  "roomFull",
];

const zeroCounters = (): Counters =>
  Object.fromEntries(COUNTER_KEYS.map((k) => [k, 0])) as unknown as Counters;

const dayId = (t = Date.now()): string => "stats:" + new Date(t).toISOString().slice(0, 10);

/** 集計値を当日の StatsDay DO に加算する。失敗しても本来の中継は止めない。 */
async function bumpStats(env: Env, delta: Partial<Counters>): Promise<void> {
  try {
    const stub = env.STATS.get(env.STATS.idFromName(dayId()));
    await stub.fetch("https://stats/bump", { method: "POST", body: JSON.stringify(delta) });
  } catch {
    /* 計測はベストエフォート。落ちてもサービスは続ける */
  }
}

/**
 * 1日分の集計カウンタ。日ごとに別 DO(idFromName("stats:YYYY-MM-DD"))なので、
 * 過去分は触らずに済み、保持期間の運用も日単位で考えられる。
 */
export class StatsDay {
  constructor(private readonly state: DurableObjectState, _env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/bump") {
      const delta = (await req.json()) as Partial<Counters>;
      const cur = (await this.state.storage.get<Counters>("c")) ?? zeroCounters();
      for (const k of COUNTER_KEYS) {
        const v = delta[k];
        // 不正値で集計を壊さない(負値・NaN・非数値は無視)
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) cur[k] += v;
      }
      await this.state.storage.put("c", cur);
      return new Response("ok");
    }
    if (path === "/host") {
      const hex = (await req.text()).trim();
      if (!/^[0-9a-f]{8,32}$/.test(hex)) return new Response("bad", { status: 400 });
      const seen = (await this.state.storage.get<string[]>("hosts")) ?? [];
      if (!seen.includes(hex) && seen.length < MAX_HOSTS_TRACKED) {
        seen.push(hex);
        await this.state.storage.put("hosts", seen);
      }
      return new Response("ok");
    }
    if (path === "/read") {
      const cur = (await this.state.storage.get<Counters>("c")) ?? zeroCounters();
      const seen = (await this.state.storage.get<string[]>("hosts")) ?? [];
      return new Response(JSON.stringify({ ...cur, uniqueHosts: seen.length }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }
}

/** 長さを揃えた上で全バイトを比較する(早期returnで秘密長や一致位置を漏らさない)。 */
function secretEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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

    // 運営者用: 直近数日の集計値。秘密が未設定なら存在自体を伏せる(404)。
    if (url.pathname === "/stats") {
      const key = url.searchParams.get("key") ?? "";
      if (!env.STATS_KEY || !secretEquals(key, env.STATS_KEY)) {
        return new Response("not found", { status: 404 });
      }
      const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 14), 1), 60);
      const out: Record<string, Counters> = {};
      for (let i = 0; i < days; i++) {
        const t = Date.now() - i * 86_400_000;
        const id = dayId(t);
        const res = await env.STATS.get(env.STATS.idFromName(id)).fetch("https://stats/read");
        out[id.slice(6)] = (await res.json()) as Counters;
      }
      return new Response(JSON.stringify(out, null, 2), {
        headers: { "content-type": "application/json" },
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

interface GateState {
  tokens: number;
  ts: number;
  blockedUntil: number;
}

/**
 * 1 IP 分の接続レート制限。
 *
 * ⚠️ バケツの状態は**必ず永続化する**。本番の DO は接続の合間(1秒未満)でも
 * 退避(eviction)されるため、メモリだけで数えるとリクエストごとにトークンが
 * 満タンに戻り、**ゆっくり接続する攻撃者は制限を完全に回避できる**(F18で実測)。
 *
 * 書き込みは**許可したときだけ**行う。拒否時に書かないので、攻撃が続いても
 * 書き込み回数は「1分あたり GATE_PER_MIN 回」に自然に頭打ちになる。
 */
export class RateGate {
  private s: GateState = { tokens: GATE_BURST, ts: Date.now(), blockedUntil: 0 };
  private loaded = false;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(_req: Request): Promise<Response> {
    if (!this.loaded) {
      const saved = await this.state.storage.get<GateState>("gate");
      if (saved) this.s = saved;
      this.loaded = true;
    }
    const now = Date.now();
    if (now < this.s.blockedUntil) return new Response("blocked", { status: 429 });

    this.s.tokens = Math.min(
      GATE_BURST,
      this.s.tokens + ((now - this.s.ts) / 60_000) * GATE_PER_MIN
    );
    this.s.ts = now;

    if (this.s.tokens < 1) {
      this.s.blockedUntil = now + GATE_BLOCK_MS;
      await this.state.storage.put("gate", this.s);
      // 計測は「ブロックに入った回数」のみ。拒否リクエスト1件ごとに数えると
      // 攻撃中に計測自体がコストになるため。
      await bumpStats(this.env, { rateLimited: 1 });
      return new Response("blocked", { status: 429 });
    }
    this.s.tokens -= 1;
    await this.state.storage.put("gate", this.s);
    return new Response("ok", { status: 200 });
  }
}

interface Attachment {
  role: "host" | "client";
  /** 接続時刻(ms)。**attachment は DO の退避をまたいで保持される**ので、
   *  接続秒数の算出はメモリではなくここに持たせる(F18の教訓)。 */
  ts?: number;
}

/** 集計をまとめて送るしきい値。1メッセージ1書き込みは無料枠を焼くため必須。 */
const STATS_FLUSH_EVERY = 100;

/**
 * 1つの room が1日に中継できるメッセージ数の上限(フェアユース)。
 *
 * ⚠️ **接続時間ではなくメッセージ数で見る。** Cloudflare の課金単位は DO リクエストで、
 * Hibernation により**無通信の接続はほぼ無料**。つまり「24時間つなぎっぱなし」は安く、
 * 「1時間で大量出力を流す」が高い。時間で上限を切ると、コストと無関係な指標で
 * 正規利用者を締め出すことになる(F33)。
 *
 * 100万通/日は、端末作業の実測(数万通/日)の20倍以上あり、通常利用では当たらない。
 * `yes` の垂れ流しのような異常だけを止めるための安全弁。
 */
const ROOM_MSGS_PER_DAY = 1_000_000;

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

  // 未送信の集計。**メモリなので DO の退避で失われる**。STATS_FLUSH_EVERY 件ごとと
  // 切断時に送るので、失われるのは最大 STATS_FLUSH_EVERY-1 件(原価把握には十分)。
  private pending: Partial<Counters> = {};
  private pendingMsgs = 0;

  // フェアユース用の日次使用量。**永続化する**(メモリだけだと DO の退避で
  // リセットされ、上限が意味を失う。F18 と同じ罠)。
  private usage?: { day: string; msgs: number };

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(req: Request): Promise<Response> {
    const role = new URL(req.url).searchParams.get("role") as "host" | "client";

    // room あたりの同時接続数を制限する。ここを開けておくと、1つの room に
    // ソケットを積み上げるだけで DO のメモリと中継コストを増やせてしまう。
    const limit = role === "host" ? MAX_HOSTS : MAX_CLIENTS;
    if (this.state.getWebSockets(role).length >= limit) {
      await bumpStats(this.env, { roomFull: 1 });
      return new Response("room is full", { status: 429, headers: { "retry-after": "30" } });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernation 対応で accept。role と接続時刻を attachment に載せて休止をまたいで保持する。
    this.state.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, ts: Date.now() } satisfies Attachment);

    // 参加を相手ロールへ通知(host は peer-joined(client) を受けて挨拶する)
    this.notifyPeers(server, role, { t: "peer-joined", role });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return; // 本プロトコルは JSON テキストのみ
    if (message.length > MSG_MAX_BYTES) {
      ws.close(1009, "message too large");
      await this.flushStats({ tooLarge: 1 });
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
    // ただし installId があれば**利用者数の集計だけ**に使う。
    if (env.t === "hello") {
      const id = (env as { installId?: unknown }).installId;
      if (typeof id === "string" && id.length >= 16 && id.length <= 64) {
        void this.countHost(id);
      }
      return;
    }
    if (env.t !== "msg") return;

    const self = this.roleOf(ws);
    if (!self) return;
    // 相手ロールへそのまま中継(payload は解釈しない)。
    // 集計より**先に**中継する(計測が遅延の原因にならないように)。
    const targetRole = self === "host" ? "client" : "host";
    for (const peer of this.state.getWebSockets(targetRole)) {
      trySend(peer, message);
    }

    this.note(self === "host" ? "msgHostToClient" : "msgClientToHost", 1);
    this.note("bytes", message.length);
    this.pendingMsgs += 1;
    if (this.pendingMsgs >= STATS_FLUSH_EVERY) {
      const n = this.pendingMsgs;
      await this.flushStats();
      // 上限判定も 100 件ごと。1通ごとに永続化すると無料枠の書き込みを焼く。
      if (await this.overDailyBudget(n)) {
        for (const peer of this.state.getWebSockets()) {
          trySend(peer, JSON.stringify({ t: "msg", payload: {
            t: "error", code: "rate-limited",
            message: "本日の中継量の上限に達しました。時間をおくか、自前のリレーをご利用ください(relay-cf/)。",
          }}));
          try { peer.close(1013, "daily budget exceeded"); } catch { /* noop */ }
        }
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.onGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onGone(ws);
  }

  /** 切断/エラー共通: 相手へ通知し、この接続分の集計を確定させる。 */
  private async onGone(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.role) this.notifyPeers(ws, att.role, { t: "peer-left", role: att.role });
    const extra: Partial<Counters> = { sessions: 1 };
    if (att?.ts) extra.connSeconds = Math.max(0, Math.round((Date.now() - att.ts) / 1000));
    await this.flushStats(extra);
  }

  /**
   * 利用者数の集計。
   *
   * ⚠️ **生の installId は保存しない。** その日の日付を混ぜて SHA-256 したものの先頭だけを
   * 持つので、日をまたいで同じ設置を突き合わせることが**こちらにもできない**。
   * 保持するのは「その日に何個の異なる値が来たか」だけ。
   */
  private async countHost(installId: string): Promise<void> {
    try {
      const day = dayId();
      const buf = new TextEncoder().encode(installId + "|" + day);
      const digest = await crypto.subtle.digest("SHA-256", buf);
      const hex = [...new Uint8Array(digest).slice(0, 8)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const stub = this.env.STATS.get(this.env.STATS.idFromName(day));
      await stub.fetch("https://stats/host", { method: "POST", body: hex });
    } catch {
      /* 集計はベストエフォート。中継は止めない */
    }
  }

  /**
   * 日次のメッセージ使用量を加算し、上限超過かを返す。
   * 日付が変わったら自動的にリセットされる(前日分は持ち越さない)。
   */
  private async overDailyBudget(add: number): Promise<boolean> {
    const day = dayId();
    if (!this.usage || this.usage.day !== day) {
      const saved = await this.state.storage.get<{ day: string; msgs: number }>("usage");
      this.usage = saved && saved.day === day ? saved : { day, msgs: 0 };
    }
    this.usage.msgs += add;
    await this.state.storage.put("usage", this.usage);
    return this.usage.msgs > ROOM_MSGS_PER_DAY;
  }

  private note(k: keyof Counters, n: number): void {
    this.pending[k] = (this.pending[k] ?? 0) + n;
  }

  /** 溜めた集計を当日ぶんへ送る。空なら何もしない。 */
  private async flushStats(extra?: Partial<Counters>): Promise<void> {
    const delta = { ...this.pending, ...{} } as Partial<Counters>;
    if (extra) for (const k of COUNTER_KEYS) {
      const v = extra[k];
      if (typeof v === "number") delta[k] = (delta[k] ?? 0) + v;
    }
    this.pending = {};
    this.pendingMsgs = 0;
    if (Object.keys(delta).length === 0) return;
    await bumpStats(this.env, delta);
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
