// OTP 인증기 — TOTP 계산과 등록 형식 해석 (크롬 API 비의존 → 단위 테스트 가능, tools/test-totp.mjs)
//
//  - TOTP(RFC 6238) / HOTP(RFC 4226) 계산: WebCrypto HMAC (SHA-1 / SHA-256 / SHA-512)
//  - Base32(RFC 4648) 인코딩·디코딩
//  - otpauth://totp/… URI 해석·생성 (Google Authenticator Key URI 형식)
//  - otpauth-migration://offline?data=… 해석 (Google OTP 앱의 「계정 내보내기」 QR, protobuf)
//
// 보안: 이 모듈은 비밀키를 받아 계산만 하고 어디에도 저장·기록하지 않는다(console 출력 금지).

export const ALGORITHMS = ["SHA1", "SHA256", "SHA512"];
export const DEFAULT_PERIOD = 30;
export const DEFAULT_DIGITS = 6;
export const MIN_SECRET_BYTES = 5;

const HASH = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" };
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const subtle = () => globalThis.crypto.subtle;

export class OtpFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "OtpFormatError";
  }
}

// ---- Base32 ----------------------------------------------------------------
/** 사람이 입력한 비밀키를 정리한다: 공백·하이픈·패딩 제거, 대문자 */
export function cleanSecret(s) {
  return String(s == null ? "" : s)
    .replace(/[\s-]/g, "")
    .replace(/=+$/, "")
    .toUpperCase();
}

export function base32Decode(input) {
  const s = cleanSecret(input);
  if (!s) throw new OtpFormatError("비밀키가 비어 있어요");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new OtpFormatError("비밀키에 쓸 수 없는 글자가 있어요 (A–Z, 2–7 만 가능)");
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** 4글자씩 띄어 보여 주기 (비밀키 보기 화면용) */
export function groupSecret(secret) {
  return cleanSecret(secret).replace(/(.{4})(?=.)/g, "$1 ");
}

// ---- 항목 정규화 -------------------------------------------------------------
/**
 * 등록 항목을 검증·정리한다. 잘못되면 OtpFormatError.
 * @returns {{issuer:string, account:string, secret:string, algorithm:string, digits:number, period:number}}
 */
export function normalizeEntry(e) {
  const secret = cleanSecret(e && e.secret);
  const bytes = base32Decode(secret);
  if (bytes.length < MIN_SECRET_BYTES) throw new OtpFormatError("비밀키가 너무 짧아요");
  const algorithm = String((e && e.algorithm) || "SHA1").toUpperCase().replace("-", "");
  if (!ALGORITHMS.includes(algorithm)) throw new OtpFormatError(`지원하지 않는 알고리즘이에요 (${algorithm})`);
  const digits = Number((e && e.digits) || DEFAULT_DIGITS);
  if (!(digits >= 6 && digits <= 8 && Number.isInteger(digits))) {
    throw new OtpFormatError("자릿수는 6~8 이어야 해요");
  }
  const period = Number((e && e.period) || DEFAULT_PERIOD);
  if (!(period >= 10 && period <= 300 && Number.isInteger(period))) {
    throw new OtpFormatError("갱신 주기는 10~300초여야 해요");
  }
  const issuer = String((e && e.issuer) || "").trim().slice(0, 64);
  const account = String((e && e.account) || "").trim().slice(0, 128);
  if (!issuer && !account) throw new OtpFormatError("서비스 이름이나 계정 중 하나는 입력하세요");
  return { issuer, account, secret, algorithm, digits, period };
}

// ---- HOTP / TOTP -------------------------------------------------------------
export async function hotp(secret, counter, { algorithm = "SHA1", digits = DEFAULT_DIGITS } = {}) {
  const keyBytes = secret instanceof Uint8Array ? secret : base32Decode(secret);
  const key = await subtle().importKey("raw", keyBytes, { name: "HMAC", hash: HASH[algorithm] }, false, ["sign"]);
  const msg = new Uint8Array(8);
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) {
    msg[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  const mac = new Uint8Array(await subtle().sign("HMAC", key, msg));
  const off = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/**
 * 현재 TOTP 코드와 남은 시간
 * @returns {Promise<{code:string, remaining:number, validUntil:number}>} remaining 은 초, validUntil 은 ms
 */
export async function totp(entry, now = Date.now()) {
  const period = entry.period || DEFAULT_PERIOD;
  const step = Math.floor(now / 1000 / period);
  const code = await hotp(entry.secret, step, { algorithm: entry.algorithm || "SHA1", digits: entry.digits || DEFAULT_DIGITS });
  const validUntil = (step + 1) * period * 1000;
  return { code, remaining: Math.ceil((validUntil - now) / 1000), validUntil };
}

// ---- otpauth:// URI ---------------------------------------------------------
function splitLabel(label) {
  const i = label.indexOf(":");
  if (i < 0) return { issuer: "", account: label.trim() };
  return { issuer: label.slice(0, i).trim(), account: label.slice(i + 1).trim() };
}

const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** otpauth://totp/Issuer:account?secret=…&issuer=… → 항목 (HOTP 는 지원하지 않음) */
export function parseOtpauthUri(uri) {
  const m = /^otpauth:\/\/([a-z]+)\/([^?#]*)(?:\?([^#]*))?/i.exec(String(uri || "").trim());
  if (!m) throw new OtpFormatError("otpauth:// 주소 형식이 아니에요");
  const type = m[1].toLowerCase();
  if (type === "hotp") throw new OtpFormatError("HOTP(카운터 방식)는 지원하지 않아요");
  if (type !== "totp") throw new OtpFormatError(`알 수 없는 OTP 종류예요 (${type})`);
  const label = splitLabel(safeDecode(m[2]));
  const params = new URLSearchParams(m[3] || "");
  return normalizeEntry({
    issuer: params.get("issuer") || label.issuer,
    account: label.account,
    secret: params.get("secret"),
    algorithm: params.get("algorithm") || "SHA1",
    digits: params.get("digits") || DEFAULT_DIGITS,
    period: params.get("period") || DEFAULT_PERIOD,
  });
}

export function buildOtpauthUri(e) {
  const label = e.issuer ? `${e.issuer}:${e.account}` : e.account;
  const q = new URLSearchParams({ secret: cleanSecret(e.secret) });
  if (e.issuer) q.set("issuer", e.issuer);
  if (e.algorithm && e.algorithm !== "SHA1") q.set("algorithm", e.algorithm);
  if (e.digits && e.digits !== DEFAULT_DIGITS) q.set("digits", String(e.digits));
  if (e.period && e.period !== DEFAULT_PERIOD) q.set("period", String(e.period));
  return `otpauth://totp/${encodeURIComponent(label).replace(/%3A/gi, ":")}?${q}`;
}

// ---- Google OTP 내보내기 (otpauth-migration) ---------------------------------
// MigrationPayload { repeated OtpParameters otp_parameters = 1; int32 version = 2;
//                    int32 batch_size = 3; int32 batch_index = 4; int32 batch_id = 5; }
// OtpParameters { bytes secret = 1; string name = 2; string issuer = 3; Algorithm algorithm = 4;
//                 DigitCount digits = 5; OtpType type = 6; int64 counter = 7; }
const MIG_ALG = { 0: "SHA1", 1: "SHA1", 2: "SHA256", 3: "SHA512", 4: "MD5" };
const MIG_DIGITS = { 0: 6, 1: 6, 2: 8 };
const MIG_TYPE = { 0: "totp", 1: "hotp", 2: "totp" };

function protoReader(bytes) {
  let pos = 0;
  const varint = () => {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      if (pos >= bytes.length) throw new OtpFormatError("내보내기 데이터가 잘렸어요");
      const b = bytes[pos++];
      result += (b & 0x7f) * mul;
      if (!(b & 0x80)) return result;
      mul *= 128;
    }
    throw new OtpFormatError("내보내기 데이터가 올바르지 않아요");
  };
  const fields = function* () {
    while (pos < bytes.length) {
      const tag = varint();
      const field = Math.floor(tag / 8);
      const wire = tag & 7;
      if (wire === 0) yield { field, value: varint() };
      else if (wire === 2) {
        const len = varint();
        if (pos + len > bytes.length) throw new OtpFormatError("내보내기 데이터가 잘렸어요");
        yield { field, bytes: bytes.subarray(pos, pos + len) };
        pos += len;
      } else if (wire === 1) pos += 8;
      else if (wire === 5) pos += 4;
      else throw new OtpFormatError("내보내기 데이터가 올바르지 않아요");
    }
  };
  return { fields };
}

function base64ToBytes(b64) {
  // URLSearchParams 가 '+' 를 공백으로 바꾸므로 되돌리고, URL-safe 형식도 받아 준다
  const s = String(b64).replace(/ /g, "+").replace(/-/g, "+").replace(/_/g, "/");
  let bin;
  try {
    bin = atob(s + "===".slice((s.length + 3) % 4));
  } catch {
    throw new OtpFormatError("내보내기 데이터를 읽지 못했어요 (base64 아님)");
  }
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const utf8 = new TextDecoder();

/**
 * otpauth-migration://offline?data=… → { entries, skipped, batch }
 *  skipped: 지원하지 않는 항목(HOTP·MD5 등) — { label, reason }
 *  batch:   { index, size } — 계정이 많으면 Google 앱이 QR 을 여러 장으로 나눈다
 */
export function parseMigrationUri(uri) {
  const m = /^otpauth-migration:\/\/offline\?(.*)$/i.exec(String(uri || "").trim());
  if (!m) throw new OtpFormatError("otpauth-migration:// 주소 형식이 아니에요");
  const data = new URLSearchParams(m[1]).get("data");
  if (!data) throw new OtpFormatError("내보내기 데이터가 비어 있어요");
  const bytes = base64ToBytes(data);

  const entries = [];
  const skipped = [];
  const batch = { index: 0, size: 1 };
  for (const f of protoReader(bytes).fields()) {
    if (f.field === 3 && f.value != null) batch.size = f.value || 1;
    else if (f.field === 4 && f.value != null) batch.index = f.value;
    else if (f.field === 1 && f.bytes) {
      const p = { secret: null, name: "", issuer: "", algorithm: 0, digits: 0, type: 0 };
      for (const g of protoReader(f.bytes).fields()) {
        if (g.field === 1 && g.bytes) p.secret = g.bytes;
        else if (g.field === 2 && g.bytes) p.name = utf8.decode(g.bytes);
        else if (g.field === 3 && g.bytes) p.issuer = utf8.decode(g.bytes);
        else if (g.field === 4) p.algorithm = g.value;
        else if (g.field === 5) p.digits = g.value;
        else if (g.field === 6) p.type = g.value;
      }
      const label = splitLabel(p.name);
      const issuer = p.issuer || label.issuer;
      const account = label.account;
      const shown = [issuer, account].filter(Boolean).join(" · ") || "(이름 없음)";
      const type = MIG_TYPE[p.type] || "totp";
      const algorithm = MIG_ALG[p.algorithm] || "SHA1";
      if (type === "hotp") {
        skipped.push({ label: shown, reason: "HOTP(카운터 방식)는 지원하지 않아요" });
        continue;
      }
      if (algorithm === "MD5") {
        skipped.push({ label: shown, reason: "MD5 알고리즘은 지원하지 않아요" });
        continue;
      }
      try {
        if (!p.secret || !p.secret.length) throw new OtpFormatError("비밀키가 없어요");
        entries.push(
          normalizeEntry({
            issuer,
            account,
            secret: base32Encode(p.secret),
            algorithm,
            digits: MIG_DIGITS[p.digits] || 6,
            period: DEFAULT_PERIOD,
          })
        );
      } catch (e) {
        skipped.push({ label: shown, reason: e.message });
      }
    }
  }
  return { entries, skipped, batch };
}

/**
 * 붙여넣은 글(여러 줄 가능) 또는 QR 내용 → { entries, skipped, batch }
 * otpauth:// 와 otpauth-migration:// 를 섞어도 된다.
 */
export function parseImportText(text) {
  const tokens = String(text || "").match(/otpauth(?:-migration)?:\/\/\S+/gi) || [];
  if (!tokens.length) {
    throw new OtpFormatError("OTP 등록 정보(otpauth:// 또는 Google OTP 내보내기 QR)가 아니에요");
  }
  const out = { entries: [], skipped: [], batch: null };
  for (const t of tokens) {
    if (/^otpauth-migration:/i.test(t)) {
      const r = parseMigrationUri(t);
      out.entries.push(...r.entries);
      out.skipped.push(...r.skipped);
      if (r.batch.size > 1) out.batch = r.batch;
    } else {
      try {
        out.entries.push(parseOtpauthUri(t));
      } catch (e) {
        out.skipped.push({ label: "otpauth://…", reason: e.message });
      }
    }
  }
  return out;
}
