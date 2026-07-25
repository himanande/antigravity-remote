// E2EE コアの正当性確認: 鍵交換→双方向 seal/open、proof 検証、改ざん検知。
import * as fs from "fs";
import {
  sodiumReady, generateKeyPair, generatePairingSecret, computeProof, proofEquals,
  deriveHostKeys, deriveClientKeys, seal, open,
} from "./src/e2ee";

const RESULT = __dirname + "/e2ee-result.txt";
const log = (s: string) => fs.appendFileSync(RESULT, s + "\n");
fs.writeFileSync(RESULT, "");

(async () => {
  await sodiumReady();
  let ok = true;
  const check = (cond: boolean, name: string) => { if (!cond) { ok = false; log("NG: " + name); } else log("ok: " + name); };

  const host = generateKeyPair();
  const client = generateKeyPair();
  const pairing = generatePairingSecret();

  // ペアリング proof(client が正当)
  const proofC = computeProof(pairing, client.publicKey, host.publicKey);
  const proofH = computeProof(pairing, client.publicKey, host.publicKey);
  check(proofEquals(proofC, proofH), "proof 一致(正当端末)");
  const wrongProof = computeProof(generatePairingSecret(), client.publicKey, host.publicKey);
  check(!proofEquals(proofC, wrongProof), "proof 不一致(別secretは弾く)");

  // 鍵導出
  const hk = deriveHostKeys(host, client.publicKey);
  const ck = deriveClientKeys(client, host.publicKey);
  check(Buffer.compare(Buffer.from(hk.tx), Buffer.from(ck.rx)) === 0, "host.tx == client.rx");
  check(Buffer.compare(Buffer.from(hk.rx), Buffer.from(ck.tx)) === 0, "host.rx == client.tx");

  // client → host
  const msg1 = { t: "input", sessionId: "s1", data: "echo hi\n" };
  const e1 = seal(ck, msg1);
  const d1 = open(hk, e1) as any;
  check(JSON.stringify(d1) === JSON.stringify(msg1), "client→host 復号一致");

  // host → client
  const msg2 = { t: "output", sessionId: "s1", data: "hi\n" };
  const e2 = seal(hk, msg2);
  const d2 = open(ck, e2) as any;
  check(JSON.stringify(d2) === JSON.stringify(msg2), "host→client 復号一致");

  // 改ざん検知
  const tampered = { ...e1, c: e1.c.slice(0, -2) + (e1.c.endsWith("A") ? "B" : "A") };
  check(open(hk, tampered) === undefined, "改ざん封筒は復号失敗(undefined)");

  // 別ペアの鍵では復号できない(盗聴者=鍵を持たない第三者)
  const evil = generateKeyPair();
  const ek = deriveClientKeys(evil, host.publicKey);
  check(open(ek, e2) === undefined, "無関係な鍵では host→client を復号できない");

  log(ok ? "PASS: E2EE コア全項目OK" : "FAIL: 不合格あり");
  process.exit(ok ? 0 : 1);
})();
