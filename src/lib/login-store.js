// 자동 로그인 데이터 저장소 — chrome.storage.sync (PC 간 동기화)
//
// 기존 텍스트 추출 기능의 데이터(storage.local: current/presets/allowedPatterns)와
// **완전히 분리**된 키 공간(`ua_*`)을 쓴다.
//
// 검증된 sync 제약 (Chrome 공식 문서)
//   QUOTA_BYTES 102,400 / QUOTA_BYTES_PER_ITEM 8,192 / MAX_ITEMS 512
//   MAX_WRITE_OPERATIONS_PER_MINUTE 120 / PER_HOUR 1,800
// → 사이트 1개 = sync 항목 1개로 **분할 저장**해 항목당 8KB 제한을 피하고,
//   다른 PC와 동시 수정 시 충돌 범위를 사이트 단위로 좁힌다.

export const SCHEMA_VERSION = 1;

export const K_INDEX = "ua_login_index"; // { schemaVersion, siteIds:[], updatedAt }
export const K_VAULT = "ua_vault"; // { schemaVersion, kdf, iterations, salt, verifier, updatedAt }
export const K_SETTINGS = "ua_login_settings"; // { autoLockMinutes }
export const SITE_PREFIX = "ua_site_";

export const MAX_ITEM_BYTES = 8192;
export const MAX_TOTAL_BYTES = 102400;

// 페이지 내 단축키 — commands API 로는 F2/F4 같은 단일 기능키를 등록할 수 없어 별도 처리.
//  hotkeyAllSites: 리스너를 모든 http(s) 페이지에 심을지(기본), 아니면 등록된 사이트에만 심을지.
//   · 켜짐 → 패널 토글(F4)을 어디서든 쓸 수 있다
//   · 꺼짐 → 등록된 로그인 사이트에서만 단축키가 동작한다(리스너 범위 최소화)
// 자동 잠금 선택지(분). 목록에 없는 값(이전 버전의 5·15·30분 등)은 바로 위 선택지로 올린다.
export const AUTO_LOCK_OPTIONS = [60, 240, 480];

export function normalizeAutoLock(value) {
  const mins = Number(value);
  if (!(mins > 0)) return AUTO_LOCK_OPTIONS[0];
  return AUTO_LOCK_OPTIONS.find((o) => o >= mins) ?? AUTO_LOCK_OPTIONS[AUTO_LOCK_OPTIONS.length - 1];
}

export const DEFAULT_SETTINGS = {
  autoLockMinutes: 60,
  hotkey: { combo: "F2", enabled: true }, // 로그인 / 로그아웃
  panelHotkey: { combo: "F4", enabled: true }, // 사이드 패널 열기·닫기
  hotkeyAllSites: true,
};

const siteKey = (id) => SITE_PREFIX + id;

export function byteSize(obj) {
  return new TextEncoder().encode(JSON.stringify(obj)).length;
}

export const uid = () =>
  (globalThis.crypto?.randomUUID && globalThis.crypto.randomUUID()) ||
  "s" + Date.now() + Math.random().toString(36).slice(2);

// ---- 저장소 접근 (실패를 삼키지 않고 호출자에게 알린다) --------------------
async function syncGet(keys) {
  return chrome.storage.sync.get(keys);
}
async function syncSet(obj) {
  const over = Object.entries(obj).find(([, v]) => byteSize(v) > MAX_ITEM_BYTES);
  if (over) {
    throw new Error(
      `항목이 너무 큽니다(${byteSize(over[1])}B > ${MAX_ITEM_BYTES}B). 계정 수를 줄이거나 사이트를 나눠 등록하세요.`
    );
  }
  await chrome.storage.sync.set(obj);
}

// ---- 인덱스 ---------------------------------------------------------------
async function getIndex() {
  const { [K_INDEX]: idx } = await syncGet(K_INDEX);
  if (idx && Array.isArray(idx.siteIds)) return idx;
  return { schemaVersion: SCHEMA_VERSION, siteIds: [], updatedAt: 0 };
}

async function setIndex(siteIds) {
  await syncSet({
    [K_INDEX]: { schemaVersion: SCHEMA_VERSION, siteIds, updatedAt: Date.now() },
  });
}

// ---- 사이트 CRUD ----------------------------------------------------------
/** 저장된 사이트 전체를 인덱스 순서대로 반환. 인덱스에만 있고 실제 항목이 없으면 건너뛴다. */
export async function loadSites() {
  const idx = await getIndex();
  if (!idx.siteIds.length) return [];
  const keys = idx.siteIds.map(siteKey);
  const bag = await syncGet(keys);
  return idx.siteIds.map((id) => bag[siteKey(id)]).filter((s) => s && s.id);
}

export async function getSite(id) {
  const { [siteKey(id)]: s } = await syncGet(siteKey(id));
  return s || null;
}

export function newSite() {
  return {
    id: uid(),
    schemaVersion: SCHEMA_VERSION,
    name: "",
    url: "",
    origin: "",
    path: "/",
    matchPath: false,
    autoLogin: true, // 이 사이트에서 자동 실행 사용 (로그인·로그아웃 공통 스위치)
    autoSubmit: true, // 로그인 버튼 자동 클릭
    autoLogout: true, // 로그인 상태면 같은 단축키로 로그아웃
    sel: { user: "", pass: "", submit: "", logout: "" },
    accounts: [],
    defaultAccountId: null,
    rev: 0,
    updatedAt: 0,
  };
}

export function newAccount() {
  return { id: uid(), label: "", username: "", secret: null };
}

/** 사이트 저장(신규/수정 공통). rev를 올려 다른 PC의 변경과 구분한다. */
export async function saveSite(site) {
  const rec = {
    ...site,
    schemaVersion: SCHEMA_VERSION,
    rev: (site.rev || 0) + 1,
    updatedAt: Date.now(),
  };
  await syncSet({ [siteKey(rec.id)]: rec });
  const idx = await getIndex();
  if (!idx.siteIds.includes(rec.id)) await setIndex([...idx.siteIds, rec.id]);
  return rec;
}

export async function deleteSite(id) {
  const idx = await getIndex();
  await setIndex(idx.siteIds.filter((x) => x !== id));
  await chrome.storage.sync.remove(siteKey(id));
}

/** 여러 사이트 + vault 메타를 한 번의 set으로 기록 (마스터 비밀번호 변경 시 재암호화용) */
export async function saveManyAtomic(sites, vaultMeta) {
  const obj = {};
  for (const s of sites) {
    obj[siteKey(s.id)] = { ...s, schemaVersion: SCHEMA_VERSION, updatedAt: Date.now() };
  }
  if (vaultMeta) obj[K_VAULT] = vaultMeta;
  await syncSet(obj);
}

/**
 * 로그인 데이터(사이트)가 하나라도 있는지.
 *
 * 다른 PC 에서 이미 쓰고 있던 계정에 새 PC 를 붙이면 Chrome sync 는 키별로 따로 도착하고
 * **순서를 보장하지 않는다.** 사이트는 왔는데 `ua_vault` 가 아직 안 온 순간에 "최초 설정"을
 * 해버리면 salt/verifier 를 새로 만들어 덮어쓰고, 기존 암호문을 영구히 열 수 없게 된다.
 * → 그 상태를 감지해 최초 설정을 막기 위한 판별.
 */
export async function hasAnyLoginData() {
  const idx = await getIndex();
  if (idx.siteIds.length) return true;
  // 인덱스가 아직 안 왔지만 사이트 항목이 먼저 온 경우까지 본다
  const all = await chrome.storage.sync.get(null);
  return Object.keys(all).some((k) => k.startsWith(SITE_PREFIX));
}

// ---- vault 메타 / 설정 ----------------------------------------------------
export async function getVaultMeta() {
  const { [K_VAULT]: v } = await syncGet(K_VAULT);
  return v || null;
}

export async function setVaultMeta(meta) {
  await syncSet({ [K_VAULT]: { ...meta, schemaVersion: SCHEMA_VERSION, updatedAt: Date.now() } });
}

export async function getSettings() {
  const { [K_SETTINGS]: s } = await syncGet(K_SETTINGS);
  return {
    ...DEFAULT_SETTINGS,
    ...(s || {}),
    autoLockMinutes: normalizeAutoLock(s ? s.autoLockMinutes : undefined),
    hotkey: { ...DEFAULT_SETTINGS.hotkey, ...((s && s.hotkey) || {}) },
    panelHotkey: { ...DEFAULT_SETTINGS.panelHotkey, ...((s && s.panelHotkey) || {}) },
  };
}

export async function setSettings(patch) {
  const cur = await getSettings();
  await syncSet({ [K_SETTINGS]: { ...cur, ...patch } });
}

// ---- 동기화 상태 ----------------------------------------------------------
/**
 * 사용량과 동기화 가용성.
 * `chrome.storage.sync`는 크롬 동기화가 꺼져 있어도 **로컬에 저장되고 동작**하며,
 * 로그인 상태가 되면 그때 올라간다. 사용자에게 상태만 알린다.
 */
export async function syncStatus() {
  let bytes = 0;
  let ok = true;
  let message = "";
  try {
    bytes = await chrome.storage.sync.getBytesInUse(null);
  } catch (e) {
    ok = false;
    message = e.message || "사용량 조회 실패";
  }
  const idx = await getIndex().catch(() => ({ siteIds: [] }));
  return {
    ok,
    message,
    bytes,
    quota: MAX_TOTAL_BYTES,
    percent: Math.min(100, Math.round((bytes / MAX_TOTAL_BYTES) * 100)),
    siteCount: idx.siteIds.length,
  };
}
