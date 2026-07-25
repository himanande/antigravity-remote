import {
  sodiumReady, generateKeyPair, generatePairingSecret, generateRoomId, b64, type KeyPair,
} from "./e2ee";

// ペアリング: ホストが鍵ペア+ペアリング秘密を生成し、QR/URL でスマホに渡す。
// URL に載せるのは「ホスト公開鍵」「ペアリング秘密」「room」「リレー」。
// 秘密は QR を読んだ端末だけが知る → room を知るだけの第三者は proof を作れない(e2ee.ts)。

export interface Pairing {
  keyPair: KeyPair;
  secret: Uint8Array;
  room: string;
}

/**
 * 新しいペアリングを生成する(sodium 初期化後に呼ぶこと)。
 * room を省略すると高エントロピーな room を毎回ランダム発行する(推奨・既定)。
 * 明示指定は後方互換/デバッグ用。
 */
export async function createPairing(room?: string): Promise<Pairing> {
  await sodiumReady();
  return {
    keyPair: generateKeyPair(),
    secret: generatePairingSecret(),
    room: room ?? generateRoomId(),
  };
}

/**
 * スマホが開くペアリングURLを組み立てる。
 * @param clientBase クライアントPWAの配信URL(例 https://app.example / ローカルは http://<ip>:8787)
 * @param relayBase  リレーのベースURL(例 wss://<worker>.workers.dev / ws://<ip>:8787)
 */
export function buildPairingUrl(p: Pairing, clientBase: string, relayBase: string): string {
  const q = new URLSearchParams({
    relay: relayBase,
    room: p.room,
    hpk: b64.enc(p.keyPair.publicKey),
    ps: b64.enc(p.secret),
  });
  return `${clientBase.replace(/\/+$/, "")}/?${q.toString()}`;
}
