// 서비스 워커: OTP 인증기
//
// 비밀키는 **이 파일(서비스 워커) 안에서만** 복호화한다. 패널에는 발급자·계정·현재 코드·남은 시간만 보낸다.
// 예외: 「비밀키 보기」는 마스터 비밀번호를 다시 입력받아 그 응답에만 비밀키를 싣는다.
// QR 이미지 해석은 오프스크린 문서가 한다(jsQR 257KB 를 스캔할 때만 불러오려고 — 서비스 워커는 import() 가 막혀 있어
// 여기서 불러오면 워커가 깰 때마다 읽게 된다). 해석한 글은 여기로 돌아오고, 읽은 비밀키는 미리보기 확인 전까지
// storage.session 에만 둔다. 패널로는 가지 않는다.
import * as store from "../lib/otp-store.js";
import { buildOtpauthUri, groupSecret, normalizeEntry, OtpFormatError, parseImportText, totp } from "../lib/totp.js";
import { getVaultMeta } from "../lib/login-store.js";
import * as vault from "../lib/vault.js";

const fail = (code, message) => ({ ok: false, code, message });
const WRONG_PW = () => fail("WRONG_PASSWORD", "마스터 비밀번호가 맞지 않아요");

async function currentVaultSalt() {
  const meta = await getVaultMeta();
  return (meta && meta.salt) || "";
}

// ---- 상태 / 잠금 -------------------------------------------------------------
async function status() {
  const [masterReady, initialized, sess, settings] = await Promise.all([
    vault.isInitialized(),
    store.isInitialized(),
    store.sessionStatus(),
    store.getOtpSettings(),
  ]);
  return { ok: true, masterReady, initialized, ...sess, settings };
}

/**
 * 마스터 비밀번호로 잠금 해제. 처음이면 OTP 키를 새로 만든다.
 * 다른 PC 에서 마스터 비밀번호를 바꾼 경우 → code "MASTER_CHANGED" (이전·현재 비밀번호를 함께 받아 옮긴다)
 */
async function unlock(password) {
  if (!password) return WRONG_PW();
  if (!(await vault.isInitialized())) {
    return fail("NO_MASTER", "먼저 「자동 로그인」에서 마스터 비밀번호를 설정하세요");
  }
  const vaultSalt = await currentVaultSalt();
  if (!(await store.isInitialized())) {
    if (!(await vault.verifyMaster(password))) return WRONG_PW();
    await store.startSession(await store.initialize(password, vaultSalt));
    return { ok: true, created: true };
  }
  const dek = await store.openWithPassword(password);
  if (dek) {
    const bound = await store.boundVaultSalt();
    if (bound !== vaultSalt) {
      // 감쌀 때와 금고가 달라졌다 → 지금 입력한 비밀번호가 현재 마스터인지 확인
      if (!(await vault.verifyMaster(password))) {
        return fail("MASTER_CHANGED", "마스터 비밀번호가 바뀌었어요. 이전 비밀번호와 현재 비밀번호를 입력해 옮기세요");
      }
      await store.bindVaultSalt(vaultSalt);
    }
    await store.startSession(dek);
    return { ok: true };
  }
  if (await vault.verifyMaster(password)) {
    return fail("MASTER_CHANGED", "이 PC 의 OTP 는 이전 마스터 비밀번호로 잠겨 있어요. 이전 비밀번호를 입력해 옮기세요");
  }
  return WRONG_PW();
}

/** 이전 마스터 비밀번호로 열어 현재 마스터 비밀번호로 다시 감싼다 */
async function migrateMaster(oldPassword, password) {
  if (!(await vault.verifyMaster(password))) return fail("WRONG_PASSWORD", "현재 마스터 비밀번호가 맞지 않아요");
  const r = await store.rewrap(oldPassword, password, await currentVaultSalt());
  if (r !== "done") return fail("WRONG_OLD", "이전 비밀번호로 열리지 않아요");
  await store.startSession(await store.openWithPassword(password));
  return { ok: true };
}

/** 자동 로그인 설정에서 마스터 비밀번호를 바꾼 직후 호출된다 */
async function rewrapAfterChange(oldPassword, newPassword) {
  const r = await store.rewrap(oldPassword, newPassword, await currentVaultSalt());
  return { ok: true, result: r };
}

// ---- 목록 / 코드 ---------------------------------------------------------------
async function list() {
  const dek = await store.requireDek();
  const now = Date.now();
  const items = [];
  for (const e of await store.loadEntries(dek)) {
    if (e.broken) {
      items.push({ id: e.id, broken: true });
      continue;
    }
    const t = await totp(e, now).catch(() => null);
    items.push({
      id: e.id,
      issuer: e.issuer,
      account: e.account,
      digits: e.digits,
      period: e.period,
      code: t ? t.code : "",
      validUntil: t ? t.validUntil : now + 30000,
    });
  }
  return { ok: true, items, now };
}

async function findEntry(dek, id) {
  const e = (await store.loadEntries(dek)).find((x) => x.id === id);
  if (!e || e.broken) throw new store.OtpError("NOT_FOUND", "항목을 찾을 수 없어요");
  return e;
}

async function copyCode(id, copyText) {
  const dek = await store.requireDek();
  const e = await findEntry(dek, id);
  const { code } = await totp(e);
  const { clearClipboard } = await store.getOtpSettings();
  await copyText(code, clearClipboard ? store.CLIPBOARD_CLEAR_MS : 0);
  await store.touchSession();
  return { ok: true, cleared: clearClipboard };
}

// ---- 등록 ------------------------------------------------------------------------
async function addManual(entry) {
  const dek = await store.requireDek();
  const item = normalizeEntry(entry);
  const existing = await store.loadEntries(dek);
  if (existing.some((x) => !x.broken && x.secret === item.secret)) {
    return fail("DUPLICATE", "같은 비밀키가 이미 등록돼 있어요");
  }
  await store.addEntries(dek, [item]);
  await store.touchSession();
  return { ok: true };
}

/** 읽은 항목을 세션에 보관하고, 비밀키를 뺀 미리보기만 돌려준다 */
async function stage(parsed) {
  const dek = await store.requireDek();
  const secrets = new Set((await store.loadEntries(dek)).filter((x) => !x.broken).map((x) => x.secret));
  const seen = new Set();
  const staged = parsed.entries.map((e, i) => {
    const duplicate = secrets.has(e.secret) || seen.has(e.secret);
    seen.add(e.secret);
    return { ...e, tmpId: String(i), duplicate };
  });
  await store.setPending(staged);
  return {
    ok: true,
    items: staged.map(({ tmpId, issuer, account, digits, period, algorithm, duplicate }) => ({
      tmpId,
      issuer,
      account,
      digits,
      period,
      algorithm,
      duplicate,
    })),
    skipped: parsed.skipped,
    batch: parsed.batch,
  };
}

async function parseText(text) {
  await store.requireDek();
  return stage(parseImportText(text));
}

const NO_QR = () => fail("NO_QR", "QR 코드를 찾지 못했어요 — QR 이 화면에 다 보이게 띄운 뒤 다시 시도하세요");

async function scanTab(windowId, decodeQr) {
  await store.requireDek();
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (e) {
    return fail("CAPTURE_FAILED", "이 화면은 캡처할 수 없어요 (크롬 설정·웹스토어 페이지 등)");
  }
  const text = await decodeQr(dataUrl);
  dataUrl = null;
  if (!text) return NO_QR();
  return stage(parseImportText(text));
}

async function scanImage(dataUrl, decodeQr) {
  await store.requireDek();
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
    return fail("BAD_IMAGE", "이미지 파일이 아니에요");
  }
  const text = await decodeQr(dataUrl).catch(() => null);
  if (!text) return NO_QR();
  return stage(parseImportText(text));
}

async function importConfirm(tmpIds) {
  const dek = await store.requireDek();
  const pending = await store.takePending();
  if (!pending.length) return fail("EXPIRED", "가져오기 시간이 지났어요 — 다시 읽어 주세요");
  const want = new Set(tmpIds || []);
  const items = pending.filter((p) => want.has(p.tmpId));
  const ids = await store.addEntries(dek, items);
  await store.touchSession();
  return { ok: true, added: ids.length };
}

// ---- 관리 ------------------------------------------------------------------------
async function update(id, patch) {
  await store.updateEntry(await store.requireDek(), id, patch || {});
  return { ok: true };
}

async function remove(id) {
  await store.requireDek();
  await store.deleteEntry(id);
  return { ok: true };
}

async function reorder(ids) {
  await store.requireDek();
  await store.reorder(ids);
  return { ok: true };
}

/** 비밀키 보기 — 잠금이 풀려 있어도 마스터 비밀번호를 다시 받는다 */
async function reveal(id, password) {
  await store.requireDek();
  const raw = password ? await store.openWithPassword(password) : null;
  if (!raw) return WRONG_PW();
  const dek = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["decrypt", "encrypt"]);
  raw.fill(0);
  const e = await findEntry(dek, id);
  return { ok: true, secret: groupSecret(e.secret), uri: buildOtpauthUri(e) };
}

// ---- 메시지 연결 -------------------------------------------------------------------
/**
 * 서비스 워커의 onMessage 에서 호출. OTP 메시지가 아니면 null.
 * @param {(text:string, clearAfterMs:number)=>Promise<void>} deps.copyText
 * @param {(dataUrl:string)=>Promise<string|null>} deps.decodeQr  이미지 → QR 내용 (오프스크린 문서)
 */
export function otpAction(msg, { copyText, decodeQr }) {
  const run = {
    OTP_STATUS: () => status(),
    OTP_UNLOCK: () => unlock(msg.password),
    OTP_MIGRATE_MASTER: () => migrateMaster(msg.oldPassword, msg.password),
    OTP_REWRAP: () => rewrapAfterChange(msg.oldPassword, msg.newPassword),
    OTP_LOCK: async () => (await store.lock(), { ok: true }),
    OTP_LIST: () => list(),
    OTP_COPY: () => copyCode(msg.id, copyText),
    OTP_ADD: () => addManual(msg.entry),
    OTP_PARSE_TEXT: () => parseText(msg.text),
    OTP_SCAN_TAB: () => scanTab(msg.windowId, decodeQr),
    OTP_SCAN_IMAGE: () => scanImage(msg.dataUrl, decodeQr),
    OTP_IMPORT_CONFIRM: () => importConfirm(msg.tmpIds),
    OTP_IMPORT_CANCEL: async () => (await store.clearPending(), { ok: true }),
    OTP_UPDATE: () => update(msg.id, msg.patch),
    OTP_DELETE: () => remove(msg.id),
    OTP_REORDER: () => reorder(msg.ids),
    OTP_REVEAL: () => reveal(msg.id, msg.password),
  }[msg && msg.type];
  if (!run) return null;
  return () =>
    run().catch((e) => {
      if (e instanceof OtpFormatError) return fail("FORMAT", e.message);
      if (e instanceof store.OtpError) return fail(e.code, e.message);
      return fail("ERROR", "처리하지 못했어요: " + (e && e.message));
    });
}
