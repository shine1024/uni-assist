// 백업 파일 만들기 / 읽기 테스트
// 실행: node tools/test-backup.mjs
import { BACKUP_FORMAT, backupFileName, buildBackup, parseBackup, summarizeBackup } from "../src/lib/backup.js";

let pass = 0;
let fail = 0;
function eq(actual, expected, name) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}\n    기대: ${JSON.stringify(expected)}\n    실제: ${JSON.stringify(actual)}`);
  }
}
const errorOf = (fn) => {
  try {
    fn();
    return "no-error";
  } catch (e) {
    return e.message;
  }
};

const vaultMeta = { schemaVersion: 1, salt: "c2FsdA==", verifier: { iv: "a", ct: "b" } };
const site = { id: "s1", name: "레드마인", accounts: [{ id: "a1", secret: { iv: "x", ct: "y" } }] };
const sync = {
  ua_vault: vaultMeta,
  ua_login_index: { siteIds: ["s1"] },
  ua_site_s1: site,
  ua_login_settings: { autoLockMinutes: 240 },
  other_extension_key: 1,
};
const local = {
  current: { rules: [{ id: "r1" }, { id: "r2" }] },
  presets: [{ name: "p" }],
  allowedPatterns: ["https://x/*"],
  someCache: "x",
};

console.log("내보내기");
const now = new Date(2026, 10, 11, 9, 30);
const backup = buildBackup({ sync, local }, now);
eq(backup.format, BACKUP_FORMAT, "형식 표시");
eq(Object.keys(backup.sync).sort(), ["ua_login_index", "ua_login_settings", "ua_site_s1", "ua_vault"], "sync 는 ua_ 키만");
eq(Object.keys(backup.local).sort(), ["allowedPatterns", "current", "presets"], "local 은 추출 데이터만");
eq(backup.sync.ua_site_s1.accounts[0].secret, { iv: "x", ct: "y" }, "비밀번호는 암호문 그대로");
eq(backupFileName(now), "uni-assist-backup-20261111.json", "파일 이름에 날짜");
eq(summarizeBackup(backup), { sites: 1, rules: 2, presets: 1, otps: 0, hasOtp: false, hasVault: true }, "요약 (예전 형식 규칙)");
const withSites = buildBackup({ sync, local: { ...local, siteRules: { "a.com": { rules: [{}, {}, {}] }, "b.com": { rules: [{}] } } } }, now);
eq(Object.keys(withSites.local).sort(), ["allowedPatterns", "current", "presets", "siteRules"], "사이트별 규칙도 포함");
eq(summarizeBackup(withSites).rules, 4, "요약은 사이트별 규칙 합계");

console.log("가져오기");
const round = parseBackup(JSON.stringify(backup));
eq(round.sync, backup.sync, "sync 왕복");
eq(round.local, backup.local, "local 왕복");
eq(errorOf(() => parseBackup("{")), "백업 파일을 읽지 못했어요 (JSON 형식이 아니에요)", "JSON 아님 거부");
eq(errorOf(() => parseBackup(JSON.stringify({ format: "x" }))), "Uni-Assist 백업 파일이 아니에요", "다른 파일 거부");
eq(
  errorOf(() => parseBackup(JSON.stringify({ ...backup, version: 99 }))),
  "지원하지 않는 백업 버전이에요 (99)",
  "모르는 버전 거부"
);
const noVault = { ...backup, sync: { ...backup.sync } };
delete noVault.sync.ua_vault;
eq(
  errorOf(() => parseBackup(JSON.stringify(noVault))),
  "백업에 금고 정보가 없어 저장된 비밀번호를 복원할 수 없어요",
  "사이트가 있는데 금고 정보가 없으면 거부"
);
const tampered = { ...backup, sync: { ...backup.sync, evil_key: 1 }, local: { ...backup.local, evil: 1 } };
const cleaned = parseBackup(JSON.stringify(tampered));
eq([("evil_key" in cleaned.sync), ("evil" in cleaned.local)], [false, false], "허용하지 않은 키는 버림");
const extractOnly = buildBackup({ sync: {}, local }, now);
eq(Object.keys(parseBackup(JSON.stringify(extractOnly)).sync), [], "자동 로그인 데이터가 없어도 가져오기 가능");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
