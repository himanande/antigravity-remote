import * as vscode from "vscode";
import * as QRCode from "qrcode";
import { defaultCwd } from "./pty";
import { SessionManager } from "./sessionManager";
import { RelayClient } from "./relayClient";
import { createPairing, buildPairingUrl, type Pairing } from "./pairing";
import { PushSender, generateVapidKeys, type VapidKeys } from "./push";
import { TerminalMirror } from "./terminalMirror";

let active:
  | { manager: SessionManager; mirror: TerminalMirror; relay?: RelayClient; pairing?: Pairing }
  | undefined;
let output: vscode.OutputChannel;
let extContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext) {
  extContext = context;
  output = vscode.window.createOutputChannel("Antigravity Remote");
  output.appendLine("Antigravity Remote 起動");

  context.subscriptions.push(
    vscode.commands.registerCommand("antigravityRemote.startSession", startSession),
    vscode.commands.registerCommand("antigravityRemote.pair", startPairing),
    vscode.commands.registerCommand("antigravityRemote.newSession", newSession),
    vscode.commands.registerCommand("antigravityRemote.killRemote", killRemote),
    vscode.commands.registerCommand("antigravityRemote.stopSession", stopSession),
    vscode.commands.registerCommand("antigravityRemote.probeAgentCommands", probeAgentCommands),
    { dispose: stopSession }
  );
}

/** VAPID 鍵を globalState に永続化して PushSender を得る。push 無効時は undefined。 */
function getPushSender(cfg: vscode.WorkspaceConfiguration): PushSender | undefined {
  if (!cfg.get<boolean>("enablePush", true)) return undefined;
  let keys = extContext.globalState.get<VapidKeys>("vapidKeys");
  if (!keys) {
    keys = generateVapidKeys();
    void extContext.globalState.update("vapidKeys", keys);
    output.appendLine("VAPID 鍵を新規生成・保存");
  }
  return new PushSender(keys, "mailto:antigravity-remote@local", (m) => output.appendLine(m));
}

/** 設定の promptPatterns(文字列配列)を RegExp[] にして SessionManager を作る。 */
function makeSessionManager(cfg: vscode.WorkspaceConfiguration): SessionManager {
  const pats = cfg.get<string[]>("promptPatterns", []);
  const promptPatterns = pats.length
    ? pats.map((s) => { try { return new RegExp(s, "i"); } catch { return null; } }).filter((r): r is RegExp => !!r)
    : undefined;
  return new SessionManager({ promptPatterns });
}

/** manager と PCミラー(TerminalMirror)をまとめて生成する。 */
function makeActive(cfg: vscode.WorkspaceConfiguration): { manager: SessionManager; mirror: TerminalMirror } {
  const manager = makeSessionManager(cfg);
  const mirror = new TerminalMirror(manager, (m) => output.appendLine(m));
  return { manager, mirror };
}

/** relayUrl(ws/wss)から、クライアントPWAの配信ベース(http/https)を推定する。 */
function deriveClientBase(cfg: vscode.WorkspaceConfiguration, relayUrl: string): string {
  const explicit = cfg.get<string>("clientBaseUrl", "");
  if (explicit) return explicit;
  return relayUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

/**
 * リレーURLが一度も設定されていない場合に案内する。
 *
 * 既定値は開発用の ws://localhost:8787 なので、そのまま実行すると
 * localhost を指すQRが出てスマホからは繋がらず、しかも失敗理由が分からない。
 * 「明示的に localhost を設定した人」(LAN利用)は妨げないよう、値そのものではなく
 * **設定済みかどうか**で判定する。
 */
async function ensureRelayConfigured(cfg: vscode.WorkspaceConfiguration): Promise<boolean> {
  const ins = cfg.inspect<string>("relayUrl");
  if (ins?.globalValue || ins?.workspaceValue || ins?.workspaceFolderValue) return true;

  const SETUP = "セットアップ手順を開く";
  const SETTINGS = "設定を開く";
  const pick = await vscode.window.showWarningMessage(
    "リレーのURLが未設定です。Antigravity Remote は中継サーバーを1つ必要とします" +
      "(Cloudflare Workers の無料枠に数分でデプロイできます)。設定するまでスマホからは接続できません。",
    { modal: true },
    SETUP,
    SETTINGS
  );
  if (pick === SETUP) {
    void vscode.env.openExternal(
      vscode.Uri.parse("https://github.com/himanande/antigravity-remote#quick-start")
    );
  } else if (pick === SETTINGS) {
    void vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "antigravityRemote.relayUrl"
    );
  }
  return false;
}

/** E2EE ペアリングを開始: 鍵ペア+秘密を生成し、QR+URL を表示してリレーに接続する。 */
async function startPairing() {
  const cfg = vscode.workspace.getConfiguration("antigravityRemote");
  if (!(await ensureRelayConfigured(cfg))) return;
  const relayUrl = cfg.get<string>("relayUrl", "ws://localhost:8787");
  const preset = cfg.get<string>("sessionPreset", "claude");
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? defaultCwd();
  const clientBase = deriveClientBase(cfg, relayUrl);

  try {
    stopSession(); // 既存接続を畳んでペアリング付きで張り直す
    // room は毎回ランダム発行(推測相乗り対策)。QRに載るのでスマホ側も自動追従する。
    const pairing = await createPairing();
    const url = buildPairingUrl(pairing, clientBase, relayUrl);
    const qrDataUrl = await QRCode.toDataURL(url, { width: 320, margin: 1 });

    active = makeActive(cfg);
    connectRelay(cfg, pairing);
    active.manager.create({ preset, cwd });

    showPairingPanel(url, qrDataUrl);
    output.appendLine(`ペアリング開始(E2EE): ${url}`);
  } catch (e) {
    vscode.window.showErrorMessage(`ペアリング開始に失敗: ${(e as Error).message}`);
    output.appendLine(`ERROR: ${(e as Error).stack ?? (e as Error).message}`);
  }
}

function showPairingPanel(url: string, qrDataUrl: string) {
  const panel = vscode.window.createWebviewPanel(
    "antigravityRemotePairing",
    "Antigravity Remote ペアリング",
    vscode.ViewColumn.Active,
    { enableScripts: false }
  );
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  panel.webview.html = `<!doctype html><html><body style="font-family:system-ui;text-align:center;padding:24px;color:#ddd;background:#1e1e1e">
    <h2>スマホで読み取ってペアリング</h2>
    <img src="${qrDataUrl}" alt="QR" style="background:#fff;padding:12px;border-radius:8px" />
    <p style="color:#888">この QR/URL には接続情報とペアリング秘密が含まれます。共有しないでください。</p>
    <p style="word-break:break-all;font-size:12px"><a href="${esc(url)}" style="color:#4ea1ff">${esc(url)}</a></p>
  </body></html>`;
}

export function deactivate() {
  stopSession();
}

/** active.manager 用のリレー接続を(再)確立する。既に接続済みなら何もしない。 */
function connectRelay(cfg: vscode.WorkspaceConfiguration, pairing?: Pairing) {
  if (!active) return;
  if (active.relay) return;
  const relayUrl = cfg.get<string>("relayUrl", "ws://localhost:8787");
  // ペアリング時はその乱数room、平文(startSession)時のみ設定のroomを使う。
  const room = pairing?.room ?? cfg.get<string>("room", "default-room");
  const relay = new RelayClient(relayUrl, active.manager, (m) => output.appendLine(m), room, pairing, getPushSender(cfg));
  relay.start();
  active.relay = relay;
  active.pairing = pairing;
  output.appendLine(`リレー接続開始 → ${relayUrl}${pairing ? "(E2EE)" : "(平文)"}`);
}

/** リレーに接続し、最初の pty セッションを作成する。既に動作中なら1本追加する。 */
async function startSession() {
  const cfg = vscode.workspace.getConfiguration("antigravityRemote");
  if (!(await ensureRelayConfigured(cfg))) return;
  const preset = cfg.get<string>("sessionPreset", "claude");
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? defaultCwd();

  try {
    if (!active) active = makeActive(cfg);
    connectRelay(cfg, active.pairing);
    output.show(true);
    const meta = active.manager.create({ preset, cwd });
    vscode.window.showInformationMessage(`セッション開始: ${meta.title}(${meta.id})`);
  } catch (e) {
    vscode.window.showErrorMessage(`セッション開始に失敗: ${(e as Error).message}`);
    output.appendLine(`ERROR: ${(e as Error).stack ?? (e as Error).message}`);
  }
}

/**
 * FR-1.4 キルスイッチ: 全リモート接続を即時遮断する。ローカルのセッションは動き続ける。
 * 現在のペアリングも無効化するので、配布済みQR/端末は再接続できない(FR-1.3 revoke-all 相当)。
 * 再びスマホから使うには「ペアリング開始」で新しいQRを発行する。
 */
function killRemote() {
  if (!active || !active.relay) {
    vscode.window.showInformationMessage("リモート接続はありません。");
    return;
  }
  active.relay.dispose();
  active.relay = undefined;
  active.pairing = undefined; // 旧ペアリング(鍵/秘密)を破棄=既存端末を失効
  output.appendLine("キルスイッチ: 全リモート接続を遮断・ペアリング失効(ローカルセッションは継続)");
  vscode.window.showWarningMessage(
    "リモート接続を遮断し、ペアリングを失効しました。ローカルのセッションは動作中です。"
  );
}

/** 追加の pty セッションをプリセットを選んで作成する(要: startSession 済み)。 */
async function newSession() {
  if (!active) {
    await startSession();
    return;
  }
  const preset = await vscode.window.showQuickPick(["claude", "bash"], {
    placeHolder: "追加セッションのプリセットを選択",
  });
  if (!preset) return;
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? defaultCwd();
  try {
    const meta = active.manager.create({ preset, cwd });
    vscode.window.showInformationMessage(`セッション追加: ${meta.title}(${meta.id})`);
  } catch (e) {
    vscode.window.showErrorMessage(`セッション追加に失敗: ${(e as Error).message}`);
  }
}

function stopSession() {
  if (!active) return;
  active.relay?.dispose();
  active.mirror.dispose();
  active.manager.dispose();
  active = undefined;
  output?.appendLine("全セッション停止・リレー切断");
}

/**
 * TASK-05: Antigravity 内部のエージェント操作コマンドが実在するかを検出する。
 * findings.md F3 で名前だけ確認済みのコマンド群を、実行環境で getCommands と突き合わせる。
 * ここでは *存在確認* のみ行い、副作用のある executeCommand は行わない
 * (引数実測は専用ワークスペースで別途、collaboration.md の安全ルールに従う)。
 */
async function probeAgentCommands() {
  const candidates = [
    "antigravity.sendPromptToAgentPanel",
    "antigravity.startNewConversation",
    "antigravity.command.accept",
    "antigravity.command.reject",
    "antigravity.prioritized.agentAcceptAllInFile",
    "antigravity.prioritized.agentRejectAllInFile",
    "antigravity.openChatView",
    "antigravity.openAgent",
  ];
  const all = new Set(await vscode.commands.getCommands(true));
  output.show(true);
  output.appendLine("--- TASK-05 内部コマンド存在確認 ---");
  const present: string[] = [];
  for (const c of candidates) {
    const ok = all.has(c);
    output.appendLine(`${ok ? "✓ 存在" : "✗ 無し"}  ${c}`);
    if (ok) present.push(c);
  }
  output.appendLine(
    `結果: ${present.length}/${candidates.length} 存在。findings.md F3 に確認日と結果を追記すること。`
  );
  vscode.window.showInformationMessage(
    `内部コマンド ${present.length}/${candidates.length} 存在(詳細は出力パネル)`
  );
}
