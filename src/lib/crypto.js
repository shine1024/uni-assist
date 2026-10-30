// 비밀번호 암·복호 순수 로직 (Web Crypto API). 크롬 API 비의존 → Node에서도 단독 테스트 가능.
//
// 설계
//  - 마스터 비밀번호는 **저장하지 않는다**. PBKDF2-SHA256으로 키를 유도해서만 쓴다.
//  - 비밀번호 본문은 AES-256-GCM으로 암호화하며, 레코드마다 **고유 IV**를 쓴다.
//  - salt / iv 는 crypto.getRandomValues (CSPRNG)로 생성한다.
//  - 반복 횟수(iterations)는 레코드에 함께 저장해, 추후 상향 조정이 가능하게 한다.

const ALG = "AES-GCM";
const KDF = "PBKDF2";
const HASH = "SHA-256";

export const KEY_BITS = 256;
export const SALT_BYTES = 16;
export const IV_BYTES = 12; // GCM 권장 96bit
export const DEFAULT_ITERATIONS = 600000; // OWASP PBKDF2-HMAC-SHA256 권장치
export const VERIFIER_PLAINTEXT = "uni-assist-vault-v1";

const subtle = () => globalThis.crypto.subtle;

// ---- 바이트 / base64 유틸 (btoa 비의존: 브라우저·Node 공통) ----------------
const B64C = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function toB64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < u8.length; i += 3) {
    const a = u8[i];
    const b = u8[i + 1];
    const c = u8[i + 2];
    out += B64C[a >> 2];
    out += B64C[((a & 3) << 4) | ((b || 0) >> 4)];
    out += b === undefined ? "=" : B64C[((b & 15) << 2) | ((c || 0) >> 6)];
    out += c === undefined ? "=" : B64C[c & 63];
  }
  return out;
}

export function fromB64(str) {
  const s = String(str || "").replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const a = B64C.indexOf(s[i]);
    const b = B64C.indexOf(s[i + 1]);
    const c = B64C.indexOf(s[i + 2]);
    const d = B64C.indexOf(s[i + 3]);
    out[o++] = (a << 2) | (b >> 4);
    if (c >= 0) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (d >= 0) out[o++] = ((c & 3) << 6) | d;
  }
  return out.subarray(0, o);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- 키 유도 -------------------------------------------------------------
/**
 * 마스터 비밀번호 + salt → AES-GCM 키.
 * extractable=true 인 이유: MV3 서비스 워커가 수시로 종료되므로 잠금 해제 세션 동안
 * raw 키를 chrome.storage.session(인메모리, 디스크 미기록)에 보관해야 한다. vault.js 참고.
 */
export async function deriveKey(masterPassword, salt, iterations = DEFAULT_ITERATIONS) {
  const base = await subtle().importKey("raw", enc.encode(String(masterPassword)), KDF, false, [
    "deriveKey",
  ]);
  return subtle().deriveKey(
    { name: KDF, salt: salt instanceof Uint8Array ? salt : fromB64(salt), iterations, hash: HASH },
    base,
    { name: ALG, length: KEY_BITS },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function exportKeyB64(key) {
  return toB64(new Uint8Array(await subtle().exportKey("raw", key)));
}

export async function importKeyB64(b64) {
  return subtle().importKey("raw", fromB64(b64), { name: ALG, length: KEY_BITS }, true, [
    "encrypt",
    "decrypt",
  ]);
}

// ---- 암·복호 -------------------------------------------------------------
/** 문자열 → { iv, ct } (둘 다 base64). IV는 호출마다 새로 생성한다. */
export async function encryptString(key, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const ct = await subtle().encrypt({ name: ALG, iv }, key, enc.encode(String(plaintext ?? "")));
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

/** { iv, ct } → 문자열. 키가 틀리거나 데이터가 변조되면 예외를 던진다(GCM 인증 실패). */
export async function decryptString(key, rec) {
  if (!rec || !rec.iv || !rec.ct) throw new Error("암호문 형식이 올바르지 않습니다");
  const pt = await subtle().decrypt({ name: ALG, iv: fromB64(rec.iv) }, key, fromB64(rec.ct));
  return dec.decode(pt);
}

// ---- 키 지문 (암호문이 어느 마스터 비밀번호로 만들어졌는지 구분) ----------
// 마스터 비밀번호를 바꾸거나, 다른 PC 에서 금고를 새로 만들어 덮어쓴 경우
// "복호화 실패"가 아니라 **원인을 알 수 있는 메시지**를 보여주기 위한 식별자.
//
// 보안: raw 키의 SHA-256 앞 6바이트만 쓴다. 이미 `ua_vault.verifier`(알려진 평문의 암호문)가
// 동기화되고 있으므로 공격자가 마스터 비밀번호를 대조할 수단은 그대로이고, 이 지문이
// 추가로 노출시키는 것은 없다. (PBKDF2 60만회가 실제 방어선)
export async function keyFingerprint(key) {
  const raw = await subtle().exportKey("raw", key);
  const h = await subtle().digest("SHA-256", raw);
  return toB64(new Uint8Array(h).subarray(0, 6));
}

/** 비밀번호 암호화 — 키 지문(kf)을 함께 기록한다 */
export async function encryptSecret(key, plaintext) {
  return { ...(await encryptString(key, plaintext)), kf: await keyFingerprint(key) };
}

/**
 * 이 암호문이 지금 키로 만들어진 것인지. 지문이 없는 예전 레코드는 판단을 보류하고 true.
 * (복호화 자체는 AES-GCM 인증이 최종 판단이고, 이건 **오류 메시지 구분용**이다)
 */
export async function secretMatchesKey(key, rec) {
  if (!rec || !rec.kf) return true;
  return rec.kf === (await keyFingerprint(key));
}

// ---- 마스터 비밀번호 검증자 ----------------------------------------------
// 마스터 비밀번호 자체를 저장하지 않고, 알려진 평문을 암호화해 둔 뒤
// 복호화 성공 여부로 비밀번호 일치를 판단한다.
export async function makeVerifier(key) {
  return encryptString(key, VERIFIER_PLAINTEXT);
}

export async function checkVerifier(key, verifier) {
  try {
    return (await decryptString(key, verifier)) === VERIFIER_PLAINTEXT;
  } catch (_) {
    return false;
  }
}
