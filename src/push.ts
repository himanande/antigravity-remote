import webpush from "web-push";
import type { PushSubscriptionJSON, PushPayload } from "./protocol";

// Web Push 送信(ホスト側)。ホストはアウトバウンド HTTPS のみでブラウザの push サービス
// (endpoint)へ POST するため、F4 のセキュリティモデル(インバウンドを開かない)に適合。
// VAPID 鍵はホストで生成・永続化し、公開鍵をクライアントへ渡して購読させる。

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  return webpush.generateVAPIDKeys();
}

export class PushSender {
  private subscription?: PushSubscriptionJSON;

  constructor(
    private readonly vapid: VapidKeys,
    private readonly subject: string = "mailto:antigravity-remote@example.com",
    private readonly log: (msg: string) => void = () => {}
  ) {}

  get publicKey(): string {
    return this.vapid.publicKey;
  }

  setSubscription(sub: PushSubscriptionJSON | undefined): void {
    this.subscription = sub;
    this.log(sub ? "push 購読を登録" : "push 購読を解除");
  }

  hasSubscription(): boolean {
    return !!this.subscription;
  }

  /** 通知を送信する。購読が無ければ何もしない。失敗(410 等)は購読を破棄する。 */
  async send(payload: PushPayload): Promise<void> {
    const sub = this.subscription;
    if (!sub) return;
    try {
      await webpush.sendNotification(
        sub as webpush.PushSubscription,
        JSON.stringify(payload),
        { vapidDetails: { subject: this.subject, publicKey: this.vapid.publicKey, privateKey: this.vapid.privateKey }, TTL: 60 }
      );
      this.log(`push 送信: ${payload.reason} ${payload.title}`);
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      this.log(`push 送信失敗 (status=${status ?? "?"})`);
      if (status === 404 || status === 410) this.subscription = undefined; // 失効
    }
  }
}
