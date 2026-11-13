// 마스터 비밀번호 · 잠금 상태 관리
//
// MV3 서비스 워커는 수십 초 유휴 시 종료된다. 따라서 "잠금 해제 상태"를 전역 변수에만
// 두면 단축키를 누를 때마다 잠금이 풀려 있지 않을 수 있다.
// → 유도된 raw 키를 `chrome.storage.session`에 둔다.
//    · 인메모리 전용, **디스크에 기록되지 않음** (크롬 공식 문서 확인)
//    · 기본 접근 수준 TRUSTED_CONTEXTS → **콘텐츠 스크립트에서 접근 불가**
//    · sync 대상이 아니므로 다른 PC로 전파되지 않음
//    · 브라우저 종료 시 소멸
//   트레이드오프: 세션 동안 raw 키가 확장 프로세스 메모리에 존재한다. 대신 디스크/동기화에는
//   절대 남지 않으며, 만료·수동 잠금 시 즉시 삭제한다.
//
// 만료는 타이머(alarms 권한) 없이 **접근 시점에 지연 평가**한다 → 추가 권한 불필요.

import {
  DEFAULT_ITERATIONS,
  SALT_BYTES,
  checkVerifier,
  decryptString,
  deriveKey,
  encryptSecret,
  exportKeyB64,
  importKeyB64,
  makeVerifier,
  randomBytes,
  toB64,
} from "./crypto.js";
import {
  getSettings,
  getVaultMeta,
  hasAnyLoginData,
  loadSites,
  saveManyAtomic,
  setVaultMeta,
  SCHEMA_VERSION,
} from "./login-store.js";

/** 동기화가 아직 도착하지 않은 상태에서 금고를 새로 만들려 할 때의 오류 코드 */
export const ERR_SYNC_PENDING = "SYNC_PENDING";

const S_UNLOCK = "ua_unlock"; // { keyB64, expiresAt }
const S_RUNNING = "ua_login_running"; // 중복 실행 방지 타임스탬프
const S_PENDING = "ua_login_pending"; // 잠금 때문에 보류된 자동 로그인 { tabId, url, at }

const RUN_LOCK_MS = 6000;
const PENDING_TTL_MS = 120000;

// ---- 상태 조회 ------------------------------------------------------------
export async function isInitialized() {
  const meta = await getVaultMeta();
  return !!(meta && meta.salt && meta.verifier);
}

/** 잠금 해제된 키(CryptoKey) 또는 null. 만료된 세션은 즉시 폐기한다. */
export async function getUnlockedKey() {
  const { [S_UNLOCK]: sess } = await chrome.storage.session.get(S_UNLOCK);
  if (!sess || !sess.keyB64) return null;
  if (!sess.expiresAt || Date.now() > sess.expiresAt) {
    await lock();
    return null;
  }
  try {
    return await importKeyB64(sess.keyB64);
  } catch (_) {
    await lock();
    return null;
  }
}

export async function status() {
  const initialized = await isInitialized();
  const { [S_UNLOCK]: sess } = await chrome.storage.session.get(S_UNLOCK);
  const live = !!(sess && sess.keyB64 && sess.expiresAt && Date.now() <= sess.expiresAt);
  const { autoLockMinutes } = await getSettings();
  return {
    initialized,
    unlocked: live,
    expiresAt: live ? sess.expiresAt : 0,
    autoLockMinutes,
  };
}

// ---- 최초 설정 / 잠금 해제 / 잠금 ----------------------------------------
export async function initVault(masterPassword) {
  if (!masterPassword || String(masterPassword).length < 8) {
    throw new Error("마스터 비밀번호는 8자 이상이어야 합니다");
  }
  if (await isInitialized()) throw new Error("이미 마스터 비밀번호가 설정되어 있습니다");

  // 사이트는 동기화됐는데 금고 정보(ua_vault)만 아직 안 온 상태 → 새로 만들면 기존 암호문을 잃는다
  if (await hasAnyLoginData()) {
    const e = new Error(
      "다른 기기의 데이터가 동기화 중입니다. 잠시 뒤 새로 고쳐서 기존 마스터 비밀번호를 입력하세요. " +
        "여기서 새로 설정하면 기존에 저장된 비밀번호를 열 수 없게 됩니다."
    );
    e.code = ERR_SYNC_PENDING;
    throw e;
  }

  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(masterPassword, salt, DEFAULT_ITERATIONS);
  await setVaultMeta({
    kdf: "PBKDF2-SHA256",
    iterations: DEFAULT_ITERATIONS,
    salt: toB64(salt),
    verifier: await makeVerifier(key),
  });
  await startSession(key);
  return true;
}

/** 성공 시 세션 시작, 실패 시 false (오류를 던지지 않아 메시지 노출을 통일) */
export async function unlock(masterPassword) {
  const meta = await getVaultMeta();
  if (!meta) throw new Error("마스터 비밀번호가 아직 설정되지 않았습니다");
  const key = await deriveKey(masterPassword, meta.salt, meta.iterations || DEFAULT_ITERATIONS);
  if (!(await checkVerifier(key, meta.verifier))) return false;
  await startSession(key);
  return true;
}

/** 세션을 건드리지 않고 마스터 비밀번호가 맞는지만 확인한다 (OTP 인증기가 같은 비밀번호를 쓰는지 확인용) */
export async function verifyMaster(masterPassword) {
  const meta = await getVaultMeta();
  if (!meta) return false;
  const key = await deriveKey(masterPassword, meta.salt, meta.iterations || DEFAULT_ITERATIONS);
  return checkVerifier(key, meta.verifier);
}

export async function lock() {
  await chrome.storage.session.remove([S_UNLOCK]);
}

async function startSession(key) {
  const { autoLockMinutes: mins } = await getSettings();
  await chrome.storage.session.set({
    [S_UNLOCK]: { keyB64: await exportKeyB64(key), expiresAt: Date.now() + mins * 60000 },
  });
}

/** 사용할 때마다 만료 시각을 연장 (활동 기반 자동 잠금) */
export async function touchUnlock() {
  const { [S_UNLOCK]: sess } = await chrome.storage.session.get(S_UNLOCK);
  if (!sess || !sess.keyB64) return;
  const { autoLockMinutes: mins } = await getSettings();
  await chrome.storage.session.set({
    [S_UNLOCK]: { ...sess, expiresAt: Date.now() + mins * 60000 },
  });
}

// ---- 마스터 비밀번호 변경 (전체 재암호화) --------------------------------
/**
 * 기존 비밀번호로 모든 계정 비밀번호를 복호화한 뒤 새 키로 재암호화한다.
 * 쓰기는 **한 번의 set 호출**로 묶어, 일부만 새 키로 바뀌는 상태를 피한다.
 */
export async function changeMaster(oldPassword, newPassword) {
  if (!newPassword || String(newPassword).length < 8) {
    throw new Error("새 마스터 비밀번호는 8자 이상이어야 합니다");
  }
  const meta = await getVaultMeta();
  if (!meta) throw new Error("마스터 비밀번호가 아직 설정되지 않았습니다");

  const oldKey = await deriveKey(oldPassword, meta.salt, meta.iterations || DEFAULT_ITERATIONS);
  if (!(await checkVerifier(oldKey, meta.verifier))) {
    throw new Error("현재 마스터 비밀번호가 일치하지 않습니다");
  }

  const salt = randomBytes(SALT_BYTES);
  const newKey = await deriveKey(newPassword, salt, DEFAULT_ITERATIONS);

  const sites = await loadSites();
  const migrated = [];
  let reencrypted = 0;
  for (const site of sites) {
    const accounts = [];
    for (const acc of site.accounts || []) {
      if (!acc.secret) {
        accounts.push(acc);
        continue;
      }
      const plain = await decryptString(oldKey, acc.secret); // 실패하면 그대로 중단
      accounts.push({ ...acc, secret: await encryptSecret(newKey, plain) });
      reencrypted++;
    }
    migrated.push({ ...site, accounts });
  }

  await saveManyAtomic(migrated, {
    schemaVersion: SCHEMA_VERSION,
    kdf: "PBKDF2-SHA256",
    iterations: DEFAULT_ITERATIONS,
    salt: toB64(salt),
    verifier: await makeVerifier(newKey),
    updatedAt: Date.now(),
  });

  await startSession(newKey);
  return { sites: migrated.length, reencrypted };
}

// ---- 중복 실행 방지 (서비스 워커 재시작에도 유지) ------------------------
export async function acquireRunLock() {
  const { [S_RUNNING]: at } = await chrome.storage.session.get(S_RUNNING);
  if (at && Date.now() - at < RUN_LOCK_MS) return false;
  await chrome.storage.session.set({ [S_RUNNING]: Date.now() });
  return true;
}

export async function releaseRunLock() {
  await chrome.storage.session.remove([S_RUNNING]);
}

// ---- 잠금으로 보류된 로그인 요청 -----------------------------------------
export async function setPending(tabId, url) {
  await chrome.storage.session.set({ [S_PENDING]: { tabId, url, at: Date.now() } });
}

export async function takePending() {
  const { [S_PENDING]: p } = await chrome.storage.session.get(S_PENDING);
  await chrome.storage.session.remove([S_PENDING]);
  if (!p || Date.now() - p.at > PENDING_TTL_MS) return null;
  return p;
}
