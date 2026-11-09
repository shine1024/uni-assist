// 자동 로그인 순수 로직 검증 (node tools/test-login.mjs) — crypto.js + login-match.js + login-store.js
import {
  DEFAULT_ITERATIONS,
  checkVerifier,
  decryptString,
  deriveKey,
  encryptSecret,
  encryptString,
  exportKeyB64,
  fromB64,
  importKeyB64,
  keyFingerprint,
  makeVerifier,
  randomBytes,
  secretMatchesKey,
  toB64,
} from "../src/lib/crypto.js";
import {
  describeSiteUrl,
  findDowngradedSites,
  findMatchingSites,
  findOriginMatchingSites,
  isDowngrade,
  isLoginHotkeyTarget,
  isValidSelector,
  normalizePath,
  parseTarget,
  pathMatches,
  siteMatches,
} from "../src/lib/login-match.js";
import { MAX_ITEM_BYTES, byteSize } from "../src/lib/login-store.js";

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

// ---- crypto ---------------------------------------------------------------
console.log("crypto: base64");
const bytes = randomBytes(37);
eq([...fromB64(toB64(bytes))], [...bytes], "임의 바이트 base64 왕복");
eq(toB64(new Uint8Array([0])), "AA==", "1바이트 패딩");
eq(toB64(new Uint8Array([0, 0])), "AAA=", "2바이트 패딩");

console.log("crypto: 암·복호 (PBKDF2 + AES-256-GCM)");
const ITER = 1000; // 테스트 속도용. 실제 기본값은 DEFAULT_ITERATIONS
const salt = randomBytes(16);
const key = await deriveKey("master-pw-1234", salt, ITER);

const rec = await encryptString(key, "p@ssw0rd 한글 🔐");
eq(await decryptString(key, rec), "p@ssw0rd 한글 🔐", "암호화 후 복호화 일치");
eq(rec.ct.includes("p@ss"), false, "암호문에 평문이 남지 않음");

const rec2 = await encryptString(key, "p@ssw0rd 한글 🔐");
eq(rec.iv !== rec2.iv, true, "같은 평문도 IV가 매번 다름");
eq(rec.ct !== rec2.ct, true, "같은 평문도 암호문이 매번 다름");

const wrongKey = await deriveKey("wrong-pw-1234", salt, ITER);
let threw = false;
try {
  await decryptString(wrongKey, rec);
} catch (_) {
  threw = true;
}
eq(threw, true, "틀린 비밀번호로 복호화하면 실패(GCM 인증)");

const otherSalt = await deriveKey("master-pw-1234", randomBytes(16), ITER);
eq(await checkVerifier(otherSalt, await makeVerifier(key)), false, "salt가 다르면 검증자 불일치");
eq(await checkVerifier(key, await makeVerifier(key)), true, "같은 키면 검증자 일치");
eq(DEFAULT_ITERATIONS >= 600000, true, "기본 PBKDF2 반복 횟수 60만 이상");

console.log("crypto: 키 지문 (어느 마스터 비밀번호로 암호화됐는지 구분)");
const fp = await keyFingerprint(key);
eq(fp === (await keyFingerprint(key)), true, "같은 키 → 같은 지문");
eq(fp === (await keyFingerprint(wrongKey)), false, "다른 키 → 다른 지문");
eq(fp.length <= 12, true, `지문은 짧다 (${fp.length}자)`);

const sec = await encryptSecret(key, "p@ssw0rd");
eq(!!sec.iv && !!sec.ct && !!sec.kf, true, "encryptSecret 이 iv/ct/kf 를 모두 기록");
eq(await decryptString(key, sec), "p@ssw0rd", "encryptSecret 결과도 정상 복호화");
eq(await secretMatchesKey(key, sec), true, "같은 키로 만든 암호문 → 일치");
eq(await secretMatchesKey(wrongKey, sec), false, "다른 키 → 불일치로 원인 구분 가능");
eq(await secretMatchesKey(key, { iv: sec.iv, ct: sec.ct }), true, "지문 없는 예전 레코드는 판단 보류(true)");
eq(JSON.stringify(sec).includes("p@ssw0rd"), false, "지문을 붙여도 평문이 남지 않음");

console.log("crypto: 세션 보관용 키 export/import");
const roundKey = await importKeyB64(await exportKeyB64(key));
eq(await decryptString(roundKey, rec), "p@ssw0rd 한글 🔐", "export→import 한 키로 복호화 가능");

// ---- login-match ----------------------------------------------------------
console.log("login-match: parseTarget / normalizePath");
eq(parseTarget("https://a.com/login").origin, "https://a.com", "origin 추출");
eq(parseTarget("https://a.com:443/login").origin, "https://a.com", "기본 포트 정규화");
eq(parseTarget("http://a.com:8080/x").origin, "http://a.com:8080", "비표준 포트 유지");
eq(parseTarget("chrome://extensions").ok, false, "chrome:// 거부");
eq(parseTarget("file:///tmp/a.html").ok, false, "file:// 거부");
eq(normalizePath("/redmine/"), "/redmine", "끝 슬래시 제거");
eq(normalizePath(""), "/", "빈 경로는 루트");

console.log("login-match: describeSiteUrl");
eq(describeSiteUrl("https://a.com"), { origin: "https://a.com", path: "/", matchPath: false }, "루트 등록 → origin 범위");
eq(
  describeSiteUrl("https://a.com/admin/login"),
  { origin: "https://a.com", path: "/admin/login", matchPath: true },
  "경로 등록 → 경로 범위"
);
eq(describeSiteUrl("ftp://a.com"), null, "지원하지 않는 프로토콜");

console.log("login-match: pathMatches (디렉터리 경계)");
eq(pathMatches("/admin/login", "/admin"), true, "하위 경로 일치");
eq(pathMatches("/administrator", "/admin"), false, "접두어만 같은 경로는 불일치");
eq(pathMatches("/x", "/"), true, "루트 등록은 모든 경로 허용");

console.log("login-match: siteMatches");
const siteOrigin = { id: "a", origin: "https://a.com", path: "/", matchPath: false };
const sitePath = { id: "b", origin: "https://a.com", path: "/admin", matchPath: true };
const sitePort = { id: "c", origin: "https://a.com:8443", path: "/", matchPath: false };
eq(siteMatches("https://a.com/anything", siteOrigin).ok, true, "origin 범위 일치");
eq(siteMatches("https://a.com/admin/login", sitePath).ok, true, "경로 범위 일치");
eq(siteMatches("https://a.com/other", sitePath).ok, false, "경로 범위 밖");
eq(siteMatches("https://a.com/", sitePort).ok, false, "같은 도메인 다른 포트는 불일치");
eq(siteMatches("http://a.com/", siteOrigin).ok, false, "프로토콜 다르면 불일치");
eq(siteMatches("https://b.com/", siteOrigin).ok, false, "호스트 다르면 불일치");

console.log("login-match: HTTPS→HTTP 다운그레이드");
eq(isDowngrade("http://a.com/admin", sitePath), true, "https 등록 사이트를 http로 접속");
eq(isDowngrade("https://a.com/admin", sitePath), false, "정상 https 접속");
eq(findDowngradedSites("http://a.com/admin", [siteOrigin, sitePath]).length, 2, "다운그레이드 사이트 수집");

console.log("login-match: findMatchingSites (구체적인 경로 우선)");
eq(
  findMatchingSites("https://a.com/admin/login", [siteOrigin, sitePath, sitePort]).map((s) => s.id),
  ["b", "a"],
  "경로가 긴 사이트가 먼저"
);
eq(findMatchingSites("https://zzz.com/", [siteOrigin, sitePath]).length, 0, "일치 없음");

console.log("login-match: isLoginHotkeyTarget (F2 는 등록된 사이트에서만)");
{
  const reg = { id: "r", origin: "https://a.com", path: "/app/login", matchPath: true };
  eq(isLoginHotkeyTarget("https://a.com/app/login", [reg]), true, "등록된 로그인 페이지");
  eq(isLoginHotkeyTarget("https://a.com/other", [reg]), true, "같은 origin 의 다른 경로(로그아웃)");
  eq(isLoginHotkeyTarget("https://b.com/", [reg]), false, "등록되지 않은 사이트는 대상 아님");
  eq(isLoginHotkeyTarget("https://a.com:8443/", [reg]), false, "포트가 다르면 대상 아님");
  eq(isLoginHotkeyTarget("http://a.com/", [reg]), true, "HTTPS 다운그레이드는 경고를 위해 대상");
  eq(isLoginHotkeyTarget("https://a.com/", [{ ...reg, autoLogin: false }]), false, "자동 로그인 꺼진 사이트는 대상 아님");
  eq(isLoginHotkeyTarget("https://a.com/", []), false, "사이트가 없으면 대상 아님");
  eq(isLoginHotkeyTarget("chrome://extensions", [reg]), false, "http(s) 가 아니면 대상 아님");
}

console.log("login-match: findOriginMatchingSites (로그아웃 — 경로 무관)");
// 재현된 버그: 로그인 페이지 경로로 등록하면 로그인 후 다른 경로에서 매칭이 깨졌다
const loginPage = { id: "lp", origin: "https://a.com", path: "/app/login", matchPath: true };
eq(findMatchingSites("https://a.com/app/my/page", [loginPage]).length, 0, "엄격 매칭은 경로가 달라 불일치");
eq(
  findOriginMatchingSites("https://a.com/app/my/page", [loginPage]).map((s) => s.id),
  ["lp"],
  "origin 매칭은 경로와 무관하게 일치 → 로그아웃 가능"
);
eq(
  findOriginMatchingSites("https://a.com:8443/x", [loginPage]).length,
  0,
  "포트가 다르면 origin 매칭도 불일치"
);
eq(findOriginMatchingSites("http://a.com/x", [loginPage]).length, 0, "프로토콜이 다르면 불일치");
eq(findOriginMatchingSites("https://b.com/x", [loginPage]).length, 0, "호스트가 다르면 불일치");
eq(
  findOriginMatchingSites("https://a.com/x", [loginPage, { id: "root", origin: "https://a.com", path: "/" }]).map(
    (s) => s.id
  ),
  ["lp", "root"],
  "경로가 긴 사이트가 먼저"
);
eq(findOriginMatchingSites("chrome://x", [loginPage]), [], "지원하지 않는 주소");

console.log("login-match: isValidSelector");
eq(isValidSelector("#id > input[name=\"q\"]"), true, "정상 셀렉터");
eq(isValidSelector(""), false, "빈 셀렉터 거부");
eq(isValidSelector("div { color: red }"), false, "CSS 블록 거부");

// ---- login-store ----------------------------------------------------------
console.log("login-store: sync 항목 용량");
const acc = { id: "a".repeat(36), label: "운영계정", username: "operator@example.com", secret: rec };
const site = {
  id: "s".repeat(36),
  schemaVersion: 1,
  name: "사내 Redmine",
  url: "https://labdev.unipost.co.kr/redmine/login",
  origin: "https://labdev.unipost.co.kr",
  path: "/redmine/login",
  matchPath: true,
  autoLogin: true,
  autoSubmit: true,
  sel: { user: "#username", pass: "#password", submit: "input[name=\"login\"]" },
  accounts: [acc],
  defaultAccountId: acc.id,
  rev: 1,
  updatedAt: Date.now(),
};
eq(byteSize(site) < MAX_ITEM_BYTES, true, `사이트 1계정 = ${byteSize(site)}B < ${MAX_ITEM_BYTES}B`);
const many = { ...site, accounts: Array.from({ length: 20 }, (_, i) => ({ ...acc, id: acc.id + i })) };
eq(byteSize(many) < MAX_ITEM_BYTES, true, `사이트 20계정 = ${byteSize(many)}B < ${MAX_ITEM_BYTES}B`);

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
