// OTP 인증기 저장소 + 암호화 (서비스 워커에서만 쓴다 — 패널은 메시지로 결과만 받는다)
//
// 키 구조 (봉투 암호화)
//   마스터 비밀번호 ─PBKDF2(OTP 전용 salt, 60만회)→ KEK ─AES-GCM→ DEK(무작위 256bit) ─AES-GCM→ 항목
//   · 마스터 비밀번호를 바꾸면 DEK 만 다시 감싼다(항목 재암호화 없음 → 중간 실패로 데이터가 깨지지 않는다)
//   · 자동 로그인 금고(vault.js)와 키가 분리돼 있다. 같은 비밀번호를 쓰되 salt 가 달라 키가 다르다.
//   · KEK 가 vault 의 salt 에 묶이지 않으므로, 다른 PC 에서 마스터를 바꿔도 이 PC 의 OTP 는
//     「이전 비밀번호」로 열어 새 비밀번호로 옮길 수 있다(rewrap).
//
// 저장 위치: chrome.storage.local (이 PC 에만 — 동기화하지 않는다)
//   ua_otp_key        { v, kdf, iterations, salt, iv, ct, updatedAt }   감싼 DEK
//   ua_otp_index      { ids: [] }                                       표시 순서
//   ua_otp_e_<id>     { v, iv, ct }   발급자·계정·비밀키 전체를 암호화(메타데이터도 노출 안 함)
// 항목 암호문은 AAD 로 자기 id 에 묶여 있어, 다른 항목 자리로 바꿔치기하면 복호화가 실패한다.
//
// 잠금 해제 세션: chrome.storage.session (메모리 전용) ua_otp_session { dekB64, expiresAt }
//   자동 로그인과 별도의 자동 잠금(30분·1시간·4시간, 기본 30분).
import { DEFAULT_ITERATIONS, deriveKey, fromB64, randomBytes, SALT_BYTES, toB64 } from "./crypto.js";
import { normalizeEntry } from "./totp.js";

export const OTP_SCHEMA = 1;
export const K_OTP_KEY = "ua_otp_key";
export const K_OTP_INDEX = "ua_otp_index";
export const OTP_ENTRY_PREFIX = "ua_otp_e_";
export const OTP_LOCAL_PREFIX = "ua_otp_"; // 백업 대상 (local)
export const K_OTP_SETTINGS = "ua_otp_settings"; // sync — 비밀이 아닌 화면 설정
export const S_OTP_SESSION = "ua_otp_session";
export const S_OTP_PENDING = "ua_otp_pending";

export const OTP_AUTO_LOCK_OPTIONS = [30, 60, 240];
export const DEFAULT_OTP_SETTINGS = { autoLockMinutes: 30, maskCodes: true, clearClipboard: true };
export const CLIPBOARD_CLEAR_MS = 30000;
const PENDING_TTL_MS = 5 * 60000;

const AAD_DEK = "ua-otp-dek-v1";
const aadEntry = (id) => "ua-otp-entry-v1:" + id;
const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

export class OtpError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// ---- 설정 (sync) -------------------------------------------------------------
export function normalizeOtpSettings(raw) {
  const s = { ...DEFAULT_OTP_SETTINGS, ...(raw && typeof raw === "object" ? raw : {}) };
  // 목록에 없는 값(예전 5·15분 등)은 바로 위 선택지로 올리고, 4시간을 넘으면 4시간
  const m = Number(s.autoLockMinutes);
  s.autoLockMinutes = !(m > 0)
    ? DEFAULT_OTP_SETTINGS.autoLockMinutes
    : (OTP_AUTO_LOCK_OPTIONS.find((o) => o >= m) ?? OTP_AUTO_LOCK_OPTIONS[OTP_AUTO_LOCK_OPTIONS.length - 1]);
  s.maskCodes = s.maskCodes !== false;
  s.clearClipboard = s.clearClipboard !== false;
  return s;
}

export async function getOtpSettings() {
  const { [K_OTP_SETTINGS]: raw } = await chrome.storage.sync.get(K_OTP_SETTINGS);
  return normalizeOtpSettings(raw);
}

export async function setOtpSettings(patch) {
  const next = normalizeOtpSettings({ ...(await getOtpSettings()), ...patch });
  await chrome.storage.sync.set({ [K_OTP_SETTINGS]: next });
  return next;
}

// ---- AES-GCM (AAD 포함) ------------------------------------------------------
async function seal(key, bytes, aad) {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, bytes);
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

async function open(key, rec, aad) {
  if (!rec || !rec.iv || !rec.ct) throw new OtpError("CORRUPT", "암호문 형식이 올바르지 않아요");
  const pt = await subtle().decrypt(
    { name: "AES-GCM", iv: fromB64(rec.iv), additionalData: enc.encode(aad) },
    key,
    fromB64(rec.ct)
  );
  return new Uint8Array(pt);
}

const importDek = (raw) => subtle().importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

// ---- DEK 감싸기 --------------------------------------------------------------
async function getKeyRecord() {
  const { [K_OTP_KEY]: rec } = await chrome.storage.local.get(K_OTP_KEY);
  return rec && rec.salt && rec.ct ? rec : null;
}

export async function isInitialized() {
  return !!(await getKeyRecord());
}

async function wrapDek(password, dekRaw, vaultSalt) {
  const salt = randomBytes(SALT_BYTES);
  const kek = await deriveKey(password, salt, DEFAULT_ITERATIONS);
  return {
    v: OTP_SCHEMA,
    kdf: "PBKDF2-SHA256",
    iterations: DEFAULT_ITERATIONS,
    salt: toB64(salt),
    ...(await seal(kek, dekRaw, AAD_DEK)),
    vaultSalt: vaultSalt || "", // 감쌀 때의 자동 로그인 금고 salt — 다르면 마스터가 바뀐 것
    updatedAt: Date.now(),
  };
}

/** 비밀번호로 DEK 를 꺼낸다. 틀리면 null */
async function unwrapDek(password, rec) {
  const kek = await deriveKey(password, rec.salt, rec.iterations || DEFAULT_ITERATIONS);
  try {
    return await open(kek, rec, AAD_DEK);
  } catch {
    return null;
  }
}

/** 처음 쓸 때: 새 DEK 를 만들어 비밀번호로 감싼다 (비밀번호 확인은 호출자가 한다) */
export async function initialize(password, vaultSalt) {
  if (await isInitialized()) throw new OtpError("ALREADY", "이미 설정돼 있어요");
  const dekRaw = randomBytes(32);
  await chrome.storage.local.set({
    [K_OTP_KEY]: await wrapDek(password, dekRaw, vaultSalt),
    [K_OTP_INDEX]: { ids: [] },
  });
  return dekRaw;
}

/** @returns {Promise<Uint8Array|null>} 맞으면 DEK raw */
export async function openWithPassword(password) {
  const rec = await getKeyRecord();
  if (!rec) throw new OtpError("NOT_INITIALIZED", "OTP 인증기가 아직 설정되지 않았어요");
  return unwrapDek(password, rec);
}

/**
 * 마스터 비밀번호가 바뀌었을 때 DEK 를 새 비밀번호로 다시 감싼다.
 * @returns {Promise<"done"|"none"|"stale">} none=OTP 미설정, stale=이전 비밀번호로 열리지 않음
 */
export async function rewrap(oldPassword, newPassword, vaultSalt) {
  const rec = await getKeyRecord();
  if (!rec) return "none";
  const dekRaw = await unwrapDek(oldPassword, rec);
  if (!dekRaw) return "stale";
  await chrome.storage.local.set({ [K_OTP_KEY]: await wrapDek(newPassword, dekRaw, vaultSalt) });
  return "done";
}

/** DEK 를 감쌀 때 기록한 금고 salt ("" = 모름) */
export async function boundVaultSalt() {
  const rec = await getKeyRecord();
  return rec ? rec.vaultSalt || "" : "";
}

/** 지금 금고 salt 로 기록만 갱신 (같은 비밀번호로 확인된 경우) */
export async function bindVaultSalt(vaultSalt) {
  const rec = await getKeyRecord();
  if (rec) await chrome.storage.local.set({ [K_OTP_KEY]: { ...rec, vaultSalt } });
}

// ---- 잠금 해제 세션 ------------------------------------------------------------
export async function startSession(dekRaw) {
  const { autoLockMinutes } = await getOtpSettings();
  await chrome.storage.session.set({
    [S_OTP_SESSION]: { dekB64: toB64(dekRaw), expiresAt: Date.now() + autoLockMinutes * 60000 },
  });
}

export async function lock() {
  await chrome.storage.session.remove([S_OTP_SESSION, S_OTP_PENDING]);
}

async function getSession() {
  const { [S_OTP_SESSION]: s } = await chrome.storage.session.get(S_OTP_SESSION);
  if (!s || !s.dekB64) return null;
  if (!s.expiresAt || Date.now() > s.expiresAt) {
    await lock();
    return null;
  }
  return s;
}

export async function sessionStatus() {
  const s = await getSession();
  return { unlocked: !!s, expiresAt: s ? s.expiresAt : 0 };
}

/** 잠금 해제된 DEK(CryptoKey). 잠겨 있으면 OtpError("LOCKED") */
export async function requireDek() {
  const s = await getSession();
  if (!s) throw new OtpError("LOCKED", "OTP 인증기가 잠겨 있어요");
  return importDek(fromB64(s.dekB64));
}

/** 복사·등록처럼 직접 쓴 경우에만 잠금 시간을 연장한다 (화면에 띄워 두는 것만으로는 연장하지 않음) */
export async function touchSession() {
  const s = await getSession();
  if (!s) return;
  const { autoLockMinutes } = await getOtpSettings();
  await chrome.storage.session.set({ [S_OTP_SESSION]: { ...s, expiresAt: Date.now() + autoLockMinutes * 60000 } });
}

// ---- 항목 --------------------------------------------------------------------
const entryKey = (id) => OTP_ENTRY_PREFIX + id;
const newId = () => globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);

async function getIndex() {
  const { [K_OTP_INDEX]: idx } = await chrome.storage.local.get(K_OTP_INDEX);
  return idx && Array.isArray(idx.ids) ? idx.ids : [];
}

export async function encryptEntry(dek, id, data) {
  return { v: OTP_SCHEMA, ...(await seal(dek, enc.encode(JSON.stringify(data)), aadEntry(id))) };
}

export async function decryptEntry(dek, id, rec) {
  return JSON.parse(dec.decode(await open(dek, rec, aadEntry(id))));
}

/**
 * 모든 항목을 복호화해 순서대로 돌려준다. 복호화에 실패한 항목은 { id, broken: true }.
 * (결과에는 비밀키가 들어 있으므로 서비스 워커 밖으로 그대로 보내면 안 된다)
 */
export async function loadEntries(dek) {
  const ids = await getIndex();
  if (!ids.length) return [];
  const bag = await chrome.storage.local.get(ids.map(entryKey));
  const out = [];
  for (const id of ids) {
    const rec = bag[entryKey(id)];
    if (!rec) continue;
    try {
      out.push({ id, ...(await decryptEntry(dek, id, rec)) });
    } catch {
      out.push({ id, broken: true });
    }
  }
  return out;
}

/** 여러 항목을 한 번에 저장 (항목 + 순서를 한 번의 set 으로) */
export async function addEntries(dek, items) {
  const ids = await getIndex();
  const write = {};
  const added = [];
  for (const it of items) {
    const data = { ...normalizeEntry(it), createdAt: Date.now() };
    const id = newId();
    write[entryKey(id)] = await encryptEntry(dek, id, data);
    ids.push(id);
    added.push(id);
  }
  if (!added.length) return [];
  write[K_OTP_INDEX] = { ids };
  await chrome.storage.local.set(write);
  return added;
}

export async function updateEntry(dek, id, patch) {
  const { [entryKey(id)]: rec } = await chrome.storage.local.get(entryKey(id));
  if (!rec) throw new OtpError("NOT_FOUND", "항목을 찾을 수 없어요");
  const cur = await decryptEntry(dek, id, rec);
  const next = {
    ...cur,
    ...normalizeEntry({
      ...cur,
      issuer: patch.issuer != null ? patch.issuer : cur.issuer,
      account: patch.account != null ? patch.account : cur.account,
    }),
  };
  await chrome.storage.local.set({ [entryKey(id)]: await encryptEntry(dek, id, next) });
}

export async function deleteEntry(id) {
  const ids = (await getIndex()).filter((x) => x !== id);
  await chrome.storage.local.set({ [K_OTP_INDEX]: { ids } });
  await chrome.storage.local.remove(entryKey(id));
}

/** 표시 순서 변경 — 모르는 id 는 버리고 빠진 id 는 뒤에 붙인다 */
export async function reorder(order) {
  const ids = await getIndex();
  const next = (Array.isArray(order) ? order : []).filter((x, i, a) => ids.includes(x) && a.indexOf(x) === i);
  for (const x of ids) if (!next.includes(x)) next.push(x);
  await chrome.storage.local.set({ [K_OTP_INDEX]: { ids: next } });
}

export async function count() {
  return (await getIndex()).length;
}

// ---- 가져오기 대기 (미리보기 → 확인) -------------------------------------------
// 스캔·붙여넣기로 읽은 항목은 비밀키를 패널로 보내지 않고 세션 저장소에 잠시 둔다.
export async function setPending(items) {
  await chrome.storage.session.set({ [S_OTP_PENDING]: { items, at: Date.now() } });
}

export async function takePending() {
  const { [S_OTP_PENDING]: p } = await chrome.storage.session.get(S_OTP_PENDING);
  await chrome.storage.session.remove(S_OTP_PENDING);
  if (!p || Date.now() - p.at > PENDING_TTL_MS) return [];
  return p.items || [];
}

export async function clearPending() {
  await chrome.storage.session.remove(S_OTP_PENDING);
}
