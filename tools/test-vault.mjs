// 저장소 + 마스터 비밀번호 종단 검증 (node tools/test-vault.mjs)
// chrome.storage 를 가짜로 끼워 넣어 login-store.js / vault.js 를 실제 호출 흐름대로 돌린다.

let pass = 0,
  fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}\n      기대: ${e}\n      실제: ${a}`);
  }
}

// ---- chrome.storage 가짜 구현 (공식 문서의 제약을 그대로 흉내) --------------
const QUOTA_BYTES = 102400;
const QUOTA_BYTES_PER_ITEM = 8192;
const MAX_ITEMS = 512;
const size = (v) => new TextEncoder().encode(JSON.stringify(v)).length;

function makeArea({ perItem = Infinity, total = Infinity, maxItems = Infinity } = {}) {
  const data = new Map();
  return {
    data,
    async get(keys) {
      const out = {};
      if (keys == null) {
        for (const [k, v] of data) out[k] = v;
        return out;
      }
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (data.has(k)) out[k] = structuredClone(data.get(k));
      }
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) {
        if (size(v) > perItem) throw new Error(`QUOTA_BYTES_PER_ITEM quota exceeded (${k})`);
      }
      const next = new Map(data);
      for (const [k, v] of Object.entries(obj)) next.set(k, structuredClone(v));
      if (next.size > maxItems) throw new Error("MAX_ITEMS quota exceeded");
      let used = 0;
      for (const [k, v] of next) used += k.length + size(v);
      if (used > total) throw new Error("QUOTA_BYTES quota exceeded");
      for (const [k, v] of next) data.set(k, v);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
    async getBytesInUse() {
      let used = 0;
      for (const [k, v] of data) used += k.length + size(v);
      return used;
    },
  };
}

const sync = makeArea({ perItem: QUOTA_BYTES_PER_ITEM, total: QUOTA_BYTES, maxItems: MAX_ITEMS });
const session = makeArea();
globalThis.chrome = { storage: { sync, session } };

// 가짜 chrome 을 먼저 설치한 뒤에 모듈을 읽어야 한다
const store = await import("../src/lib/login-store.js");
const vault = await import("../src/lib/vault.js");
const { decryptString, encryptString } = await import("../src/lib/crypto.js");

const MASTER = "master-pass-1234";
const NEW_MASTER = "new-master-9876";

// ---- 초기 상태 ------------------------------------------------------------
console.log("vault: 초기 상태");
eq(await vault.isInitialized(), false, "처음에는 미설정");
eq((await vault.status()).unlocked, false, "처음에는 잠김");
eq((await vault.status()).autoLockMinutes, 60, "기본 자동 잠금 1시간");
eq(await vault.getUnlockedKey(), null, "미설정 상태에서 키 없음");

console.log("vault: 최초 설정");
await vault.initVault(MASTER);
eq(await vault.isInitialized(), true, "설정 후 initialized");
eq((await vault.status()).unlocked, true, "설정 직후 잠금 해제 상태");
const meta = await store.getVaultMeta();
eq(typeof meta.salt === "string" && meta.salt.length > 0, true, "salt 저장됨");
eq(meta.iterations >= 600000, true, "반복 횟수 저장됨");
eq(JSON.stringify(meta).includes(MASTER), false, "vault 메타에 마스터 비밀번호 평문 없음");

let threw = "";
try {
  await vault.initVault("short");
} catch (e) {
  threw = e.message;
}
eq(threw.includes("8자"), true, "8자 미만 거부");

// ---- 사이트 + 암호화된 계정 저장 -----------------------------------------
console.log("login-store: 사이트/계정 저장");
const key = await vault.getUnlockedKey();
eq(key !== null, true, "해제된 키 획득");

const site = store.newSite();
site.name = "사내 Redmine";
site.url = "https://labdev.unipost.co.kr/redmine/login";
site.origin = "https://labdev.unipost.co.kr";
site.path = "/redmine/login";
site.matchPath = true;
site.sel = { user: "#username", pass: "#password", submit: 'input[name="login"]' };
const acc = store.newAccount();
acc.label = "운영계정";
acc.username = "operator";
acc.secret = await encryptString(key, "s3cret-pw!");
site.accounts = [acc];
site.defaultAccountId = acc.id;
const saved = await store.saveSite(site);
eq(saved.rev, 1, "저장 시 rev 증가");

const loaded = await store.loadSites();
eq(loaded.length, 1, "사이트 1개 로드");
eq(loaded[0].name, "사내 Redmine", "이름 유지");
eq(await decryptString(key, loaded[0].accounts[0].secret), "s3cret-pw!", "저장된 비밀번호 복호화");

const dump = JSON.stringify([...sync.data.values()]);
eq(dump.includes("s3cret-pw!"), false, "sync 저장소에 비밀번호 평문 없음");
eq(dump.includes(MASTER), false, "sync 저장소에 마스터 비밀번호 없음");
const sessDump = JSON.stringify([...session.data.values()]);
eq(sessDump.includes(MASTER), false, "session 저장소에 마스터 비밀번호 없음(키만 보관)");

console.log("login-store: 동기화 상태 / 용량");
const st = await store.syncStatus();
eq(st.ok && st.siteCount === 1, true, `사용량 조회 (${st.bytes}B / ${st.quota}B)`);

let big = "";
try {
  const fat = { ...saved, name: "x".repeat(9000) };
  await store.saveSite(fat);
} catch (e) {
  big = e.message;
}
eq(big.includes("너무 큽니다"), true, "항목 8KB 초과 시 사용자용 메시지로 거부");

// ---- 설정 병합 ------------------------------------------------------------
console.log("login-store: 설정 기본값 / 부분 저장");
const defs = await store.getSettings();
eq(defs.autoLockMinutes, 60, "자동 잠금 기본 1시간");
eq(defs.hotkey, { combo: "F2", enabled: true }, "로그인 단축키 기본 F2");
eq(defs.panelHotkey, { combo: "F4", enabled: true }, "패널 단축키 기본 F4");
eq(defs.copyHotkey, { combo: "Ctrl+Shift+Y", enabled: true }, "복사 단축키 기본 Ctrl+Shift+Y");
eq(defs.hotkeyAllSites, true, "기본은 모든 사이트에서 단축키 사용");

// 중첩 객체가 다른 설정 변경에 휩쓸려 날아가지 않아야 한다
await store.setSettings({ panelHotkey: { combo: "F9", enabled: true } });
await store.setSettings({ autoLockMinutes: 240 });
const merged = await store.getSettings();
eq(merged.panelHotkey, { combo: "F9", enabled: true }, "다른 설정을 바꿔도 패널 단축키 유지");
eq(merged.hotkey, { combo: "F2", enabled: true }, "저장 안 한 단축키는 기본값 유지");
eq(merged.autoLockMinutes, 240, "자동 잠금 변경 반영");
await store.setSettings({ autoLockMinutes: 15 });
eq((await store.getSettings()).autoLockMinutes, 60, "이전 버전 값(15분)은 1시간으로 올림");
await store.setSettings({ autoLockMinutes: 300 });
eq((await store.getSettings()).autoLockMinutes, 480, "선택지 사이 값은 바로 위 선택지로");
await store.setSettings({ autoLockMinutes: 9999 });
eq((await store.getSettings()).autoLockMinutes, 480, "최대 8시간");

// 부분 저장(enabled 만) 시에도 combo 가 보존돼야 한다
await store.setSettings({ panelHotkey: { ...merged.panelHotkey, enabled: false } });
eq((await store.getSettings()).panelHotkey, { combo: "F9", enabled: false }, "combo 보존 + enabled 변경");
await store.setSettings({ panelHotkey: { combo: "F4", enabled: true }, autoLockMinutes: 60 });

console.log("login-store: 신규 사이트 기본값");
const fresh = store.newSite();
eq(fresh.sel, { user: "", pass: "", submit: "", logout: "" }, "로그아웃 셀렉터 포함");
eq(fresh.autoLogout, true, "로그아웃 기본 사용");
eq(fresh.autoLogin, true, "사이트 기본 사용");

// ---- 잠금 / 해제 / 만료 ---------------------------------------------------
console.log("vault: 잠금 · 해제 · 만료");
await vault.lock();
eq(await vault.getUnlockedKey(), null, "수동 잠금 후 키 없음");
eq(await vault.unlock("wrong-password"), false, "틀린 마스터 비밀번호 거부");
eq(await vault.getUnlockedKey(), null, "실패 후에도 잠김 유지");
eq(await vault.unlock(MASTER), true, "올바른 마스터 비밀번호로 해제");
eq((await vault.getUnlockedKey()) !== null, true, "해제 후 키 사용 가능");

// 만료 시각을 과거로 돌려 지연 평가를 확인
const sess = (await session.get("ua_unlock")).ua_unlock;
await session.set({ ua_unlock: { ...sess, expiresAt: Date.now() - 1 } });
eq(await vault.getUnlockedKey(), null, "만료된 세션은 접근 시점에 폐기");
eq((await session.get("ua_unlock")).ua_unlock, undefined, "만료 세션이 실제로 삭제됨");

await vault.unlock(MASTER);
await store.setSettings({ autoLockMinutes: 480 });
await vault.touchUnlock();
const after = (await session.get("ua_unlock")).ua_unlock;
eq(after.expiresAt - Date.now() > 470 * 60000, true, "touchUnlock 이 새 간격(8시간)으로 연장");

// ---- 마스터 비밀번호 변경 (전체 재암호화) --------------------------------
console.log("vault: 마스터 비밀번호 변경");
let cmErr = "";
try {
  await vault.changeMaster("wrong-old", NEW_MASTER);
} catch (e) {
  cmErr = e.message;
}
eq(cmErr.includes("일치하지 않습니다"), true, "현재 비밀번호 불일치 시 거부");

const oldSaltBefore = (await store.getVaultMeta()).salt;
const r = await vault.changeMaster(MASTER, NEW_MASTER);
eq(r, { sites: 1, reencrypted: 1 }, "사이트 1개 / 비밀번호 1건 재암호화");
eq((await store.getVaultMeta()).salt !== oldSaltBefore, true, "salt 재생성");

await vault.lock();
eq(await vault.unlock(MASTER), false, "이전 마스터 비밀번호는 더 이상 통하지 않음");
eq(await vault.unlock(NEW_MASTER), true, "새 마스터 비밀번호로 해제");
const newKey = await vault.getUnlockedKey();
const reloaded = await store.loadSites();
eq(
  await decryptString(newKey, reloaded[0].accounts[0].secret),
  "s3cret-pw!",
  "재암호화된 비밀번호를 새 키로 복호화"
);

// ---- 중복 실행 락 / 보류 요청 --------------------------------------------
console.log("vault: 중복 실행 방지 · 보류 요청");
eq(await vault.acquireRunLock(), true, "첫 실행은 락 획득");
eq(await vault.acquireRunLock(), false, "연속 실행은 차단");
await vault.releaseRunLock();
eq(await vault.acquireRunLock(), true, "해제 후 다시 획득");
await vault.releaseRunLock();

await vault.setPending(42, "https://a.com/login");
const p1 = await vault.takePending();
eq(p1 && p1.tabId, 42, "보류 요청 회수");
eq(await vault.takePending(), null, "한 번 회수하면 비워짐");

await session.set({ ua_login_pending: { tabId: 7, url: "x", at: Date.now() - 200000 } });
eq(await vault.takePending(), null, "오래된(2분 초과) 보류 요청은 무시");

// ---- 삭제 ----------------------------------------------------------------
console.log("login-store: 삭제");
await store.deleteSite(reloaded[0].id);
eq((await store.loadSites()).length, 0, "사이트 삭제 후 목록 비어 있음");
eq((await store.getVaultMeta()) !== null, true, "사이트를 지워도 vault 메타는 유지");

// ---- 동기화 경합 가드 -----------------------------------------------------
// 다른 PC 에서 쓰던 계정에 새 PC 를 붙이면 sync 는 키별로 따로 도착한다.
// 사이트는 왔는데 ua_vault 가 아직 안 온 순간에 "최초 설정"을 하면 기존 암호문을 영구히 잃는다.
console.log("vault: 동기화 도착 전 '최초 설정' 차단");
sync.data.clear();
session.data.clear();
eq(await vault.isInitialized(), false, "금고 정보 없음");
eq(await store.hasAnyLoginData(), false, "데이터도 없음 → 최초 설정 가능한 상태");

const early = store.newSite();
early.name = "먼저 도착한 사이트";
early.origin = "https://a.com";
await store.saveSite(early);
eq(await store.hasAnyLoginData(), true, "사이트가 먼저 도착한 상태 감지");

let guard = "";
try {
  await vault.initVault("brand-new-master");
} catch (e) {
  guard = e.code || "(코드 없음)";
}
eq(guard, vault.ERR_SYNC_PENDING, "금고 없이 사이트가 있으면 최초 설정을 차단");
eq(await vault.isInitialized(), false, "차단되었으므로 금고가 만들어지지 않음");
eq(await vault.getUnlockedKey(), null, "세션도 시작되지 않음");

// 인덱스보다 사이트 항목이 먼저 도착한 경우까지 감지해야 한다
sync.data.clear();
await sync.set({ ua_site_zzz: { id: "zzz", name: "인덱스 없이 온 사이트" } });
eq(await store.hasAnyLoginData(), true, "인덱스 없이 사이트 항목만 있어도 감지");

// 데이터가 전혀 없으면 정상적으로 최초 설정이 된다
sync.data.clear();
eq(await vault.initVault("fresh-master-1234"), true, "깨끗한 상태에서는 최초 설정 성공");
eq(await vault.isInitialized(), true, "금고 생성됨");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
