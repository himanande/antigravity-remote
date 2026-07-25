import _sodium from "libsodium-wrappers";

// アプリ層E2EE(ADR-002)。ホスト(Node)とスマホ(ブラウザ)で同じ手順を踏む。
//
// 鍵交換: X25519(crypto_kx)。host=server 側、client=client 側で rx/tx 鍵ペアを導出。
//   host.tx == client.rx、host.rx == client.tx になるので、各自 tx で暗号化・rx で復号する。
// 認証暗号: crypto_secretbox(XSalsa20-Poly1305)。メッセージ毎にランダム nonce。
// ペアリング認証: QR に載せた pairing secret を使い、client が「正当な端末」であることを
//   HMAC(BLAKE2b keyed)で証明する。room を知っているだけの第三者は proof を作れない。

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface SessionKeys {
  rx: Uint8Array; // 受信復号鍵
  tx: Uint8Array; // 送信暗号鍵
}

let ready: Promise<void> | undefined;
export function sodiumReady(): Promise<void> {
  if (!ready) ready = _sodium.ready.then(() => undefined);
  return ready;
}
function s() {
  return _sodium;
}

export const b64 = {
  enc: (u: Uint8Array): string => s().to_base64(u, s().base64_variants.URLSAFE_NO_PADDING),
  dec: (str: string): Uint8Array => s().from_base64(str, s().base64_variants.URLSAFE_NO_PADDING),
};

export function generateKeyPair(): KeyPair {
  const kp = s().crypto_kx_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

/** ペアリング秘密をランダム生成(QRに載せる)。 */
export function generatePairingSecret(): Uint8Array {
  return s().randombytes_buf(32);
}

/**
 * リレー上の room(テナント)識別子をランダム生成する。
 * 推測可能な固定値(例 "default-room")だと第三者が同じ部屋へ相乗り接続できてしまう
 * (中身はE2EEで読めないが妨害・課金増の温床)。ペアリング毎に高エントロピー値を発行する。
 * 16バイト=128ビットの url-safe base64(パディング無し)。
 */
export function generateRoomId(): string {
  return b64.enc(s().randombytes_buf(16));
}

/** client が host に示す証明: keyed-hash(pairingSecret, clientPk || hostPk)。 */
export function computeProof(pairingSecret: Uint8Array, clientPk: Uint8Array, hostPk: Uint8Array): Uint8Array {
  const msg = new Uint8Array(clientPk.length + hostPk.length);
  msg.set(clientPk, 0);
  msg.set(hostPk, clientPk.length);
  return s().crypto_generichash(32, msg, pairingSecret);
}

export function proofEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // 定数時間比較
  return s().memcmp ? s().memcmp(a, b) : timingSafeEq(a, b);
}
function timingSafeEq(a: Uint8Array, b: Uint8Array): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** host 側(server)の session 鍵導出。 */
export function deriveHostKeys(host: KeyPair, clientPk: Uint8Array): SessionKeys {
  const k = s().crypto_kx_server_session_keys(host.publicKey, host.privateKey, clientPk);
  return { rx: k.sharedRx, tx: k.sharedTx };
}

/** client 側の session 鍵導出。 */
export function deriveClientKeys(client: KeyPair, hostPk: Uint8Array): SessionKeys {
  const k = s().crypto_kx_client_session_keys(client.publicKey, client.privateKey, hostPk);
  return { rx: k.sharedRx, tx: k.sharedTx };
}

export interface EncEnvelope {
  t: "enc";
  n: string; // nonce (b64)
  c: string; // ciphertext (b64)
}

/** 任意の JSON 値を tx 鍵で暗号化して封筒にする。 */
export function seal(keys: SessionKeys, value: unknown): EncEnvelope {
  const nonce = s().randombytes_buf(s().crypto_secretbox_NONCEBYTES);
  const plain = s().from_string(JSON.stringify(value));
  const cipher = s().crypto_secretbox_easy(plain, nonce, keys.tx);
  return { t: "enc", n: b64.enc(nonce), c: b64.enc(cipher) };
}

/** 封筒を rx 鍵で復号して JSON 値に戻す。失敗時は undefined(改ざん/鍵不一致)。 */
export function open(keys: SessionKeys, env: EncEnvelope): unknown | undefined {
  try {
    const nonce = b64.dec(env.n);
    const cipher = b64.dec(env.c);
    const plain = s().crypto_secretbox_open_easy(cipher, nonce, keys.rx);
    return JSON.parse(s().to_string(plain));
  } catch {
    return undefined;
  }
}
