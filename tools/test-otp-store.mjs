// OTP 인증기 저장소·서비스 워커 처리 종단 검증 (node tools/test-otp-store.mjs)
// chrome.storage 를 가짜로 끼워 넣고 background/otp.js 의 메시지 처리를 실제 흐름대로 돌린다.

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

function makeArea() {
  const data = new Map();
  return {
    data,
    async get(keys) {
      const out = {};
      if (keys == null) {
        for (const [k, v] of data) out[k] = structuredClone(v);
        return out;
      }
      for (const k of Array.isArray(keys) ? keys : [keys]) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}

const local = makeArea();
const sync = makeArea();
const session = makeArea();
let clipboard = [];
globalThis.chrome = {
  storage: { local, sync, session },
  tabs: { captureVisibleTab: async () => "data:image/png;base64,AAAA" },
};

const vault = await import("../src/lib/vault.js");
const store = await import("../src/lib/otp-store.js");
const { otpAction } = await import("../src/background/otp.js");
const { totp } = await import("../src/lib/totp.js");

let qrText = null; // 가짜 QR 해석 결과 (실제로는 오프스크린 문서가 jsQR 로 해석)
const decoded = [];
const decodeQr = async (dataUrl) => (decoded.push(dataUrl), qrText);
const call = (msg) => otpAction(msg, { copyText: async (t, ms) => clipboard.push([t, ms]), decodeQr })();
const PW = "correct horse 1";
const PW2 = "battery staple 2";
const SECRET = "JBSWY3DPEHPK3PXP";

console.log("마스터 비밀번호 전");
eq((await call({ type: "OTP_STATUS" })).masterReady, false, "금고 미설정");
eq((await call({ type: "OTP_UNLOCK", password: PW })).code, "NO_MASTER", "금고 없이 시작 불가");
eq(otpAction({ type: "LOGIN_RUN" }, {}), null, "OTP 메시지가 아니면 null");

await vault.initVault(PW);

console.log("처음 시작 / 잠금");
eq((await call({ type: "OTP_UNLOCK", password: "wrong pass" })).code, "WRONG_PASSWORD", "틀린 비밀번호로는 만들지 않음");
eq(await store.isInitialized(), false, "→ 키가 생기지 않음");
eq((await call({ type: "OTP_UNLOCK", password: PW })).created, true, "마스터 비밀번호로 시작");
let st = await call({ type: "OTP_STATUS" });
eq([st.initialized, st.unlocked], [true, true], "설정됨·해제됨");
eq(Math.round((st.expiresAt - Date.now()) / 60000), 30, "기본 자동 잠금 30분 (자동 로그인과 별도)");
eq((await call({ type: "OTP_LIST" })).items, [], "빈 목록");

console.log("직접 입력");
eq((await call({ type: "OTP_ADD", entry: { issuer: "GitHub", account: "me", secret: SECRET.toLowerCase() } })).ok, true, "추가");
eq((await call({ type: "OTP_ADD", entry: { issuer: "Dup", account: "x", secret: SECRET } })).code, "DUPLICATE", "같은 비밀키 중복 거부");
eq((await call({ type: "OTP_ADD", entry: { issuer: "Bad", secret: "123" } })).code, "FORMAT", "형식 오류 → FORMAT");

let list = await call({ type: "OTP_LIST" });
eq(list.items.length, 1, "1개");
const gh = list.items[0];
eq(Object.keys(gh).sort(), ["account", "code", "digits", "id", "issuer", "period", "validUntil"], "패널로 가는 필드에 비밀키 없음");
eq(gh.code, (await totp({ secret: SECRET, period: 30, digits: 6 }, list.now)).code, "코드 일치");

console.log("저장 형태 (암호화·메타데이터 보호)");
const raw = JSON.stringify([...local.data.entries()]);
eq([raw.includes(SECRET), raw.includes("GitHub"), raw.includes('"me"')], [false, false, false], "비밀키·발급자·계정이 평문으로 없음");
eq([...sync.data.keys()].some((k) => k.startsWith("ua_otp_e_")), false, "OTP 항목은 동기화 저장소에 없음");
const keyRec = local.data.get(store.K_OTP_KEY);
eq([keyRec.kdf, keyRec.iterations, keyRec.vaultSalt === sync.data.get("ua_vault").salt], ["PBKDF2-SHA256", 600000, true], "감싼 키 기록");

console.log("AAD — 항목 바꿔치기 방지");
await call({ type: "OTP_ADD", entry: { issuer: "Slack", account: "you", secret: "KRSXG5CTMVRXEZLUKN2XAZLSKNSWG4TFOQ" } });
list = await call({ type: "OTP_LIST" });
const [a, b] = list.items;
const ka = "ua_otp_e_" + a.id;
const kb = "ua_otp_e_" + b.id;
const saved = local.data.get(ka);
local.data.set(ka, local.data.get(kb));
list = await call({ type: "OTP_LIST" });
eq(list.items.find((x) => x.id === a.id).broken, true, "다른 자리로 옮긴 암호문은 복호화 실패(broken)");
local.data.set(ka, saved);
eq((await call({ type: "OTP_LIST" })).items.every((x) => !x.broken), true, "원래대로 되돌리면 정상");

console.log("수정 / 순서 / 복사");
eq((await call({ type: "OTP_UPDATE", id: a.id, patch: { issuer: "GitHub Inc", account: "me2" } })).ok, true, "이름 수정");
list = await call({ type: "OTP_LIST" });
eq([list.items[0].issuer, list.items[0].account], ["GitHub Inc", "me2"], "수정 반영");
await call({ type: "OTP_REORDER", ids: [b.id, a.id, "zzz"] });
eq((await call({ type: "OTP_LIST" })).items.map((x) => x.id), [b.id, a.id], "순서 변경(모르는 id 무시)");
const beforeCopy = (await call({ type: "OTP_STATUS" })).expiresAt;
await new Promise((r) => setTimeout(r, 5));
const cp = await call({ type: "OTP_COPY", id: a.id });
eq([cp.ok, cp.cleared, clipboard.length, clipboard[0][1]], [true, true, 1, 30000], "복사 + 30초 뒤 지우기 요청");
eq(clipboard[0][0], (await totp({ secret: SECRET }, Date.now())).code, "복사한 값 = 현재 코드");
eq((await call({ type: "OTP_STATUS" })).expiresAt > beforeCopy, true, "복사하면 잠금 시간 연장");
await store.setOtpSettings({ clearClipboard: false });
eq((await call({ type: "OTP_COPY", id: a.id })).cleared, false, "지우기 끄면 cleared=false");
eq(clipboard[1][1], 0, "→ 지우기 요청 없음");

console.log("가져오기 (미리보기 → 확인)");
const text = `otpauth://totp/AWS:root?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=AWS\notpauth://totp/Dup:x?secret=${SECRET}`;
const staged = await call({ type: "OTP_PARSE_TEXT", text });
eq(staged.items.map((x) => [x.issuer, x.duplicate]), [["AWS", false], ["Dup", true]], "중복 표시");
eq(JSON.stringify(staged).includes("GEZDGNBV"), false, "미리보기 응답에 비밀키 없음");
eq(JSON.stringify([...session.data.values()]).includes("GEZDGNBV"), true, "비밀키는 세션 저장소에만 대기");
const imp = await call({ type: "OTP_IMPORT_CONFIRM", tmpIds: ["0"] });
eq(imp.added, 1, "선택한 것만 추가");
eq((await call({ type: "OTP_IMPORT_CONFIRM", tmpIds: ["0"] })).code, "EXPIRED", "대기 항목은 한 번만 쓸 수 있음");
eq(session.data.has(store.S_OTP_PENDING), false, "대기 항목 폐기");
eq((await call({ type: "OTP_SCAN_IMAGE", dataUrl: "javascript:alert(1)" })).code, "BAD_IMAGE", "이미지 아닌 값 거부");
eq(decoded.length, 0, "→ 해석기로 보내지도 않음");
qrText = null;
eq((await call({ type: "OTP_SCAN_TAB", windowId: 1 })).code, "NO_QR", "화면에 QR 없음");
eq(decoded, ["data:image/png;base64,AAAA"], "화면 캡처를 해석기로 보냄");
qrText = "otpauth://totp/Scan:me?secret=MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U&issuer=Scan";
const sc = await call({ type: "OTP_SCAN_IMAGE", dataUrl: "data:image/gif;base64,R0lG" });
eq([sc.ok, sc.items.length, sc.items[0].issuer, JSON.stringify(sc).includes("MFRGGZDF")], [true, 1, "Scan", false], "QR 이미지 → 미리보기(비밀키 없음)");
await call({ type: "OTP_IMPORT_CANCEL" });

console.log("비밀키 보기 (마스터 재확인)");
eq((await call({ type: "OTP_REVEAL", id: a.id, password: "nope" })).code, "WRONG_PASSWORD", "틀리면 거부");
const rv = await call({ type: "OTP_REVEAL", id: a.id, password: PW });
eq([rv.secret, rv.uri], ["JBSW Y3DP EHPK 3PXP", "otpauth://totp/GitHub%20Inc:me2?secret=JBSWY3DPEHPK3PXP&issuer=GitHub+Inc"], "비밀키·URI");

console.log("잠금");
await call({ type: "OTP_LOCK" });
eq((await call({ type: "OTP_LIST" })).code, "LOCKED", "잠그면 목록 불가");
eq((await call({ type: "OTP_COPY", id: a.id })).code, "LOCKED", "잠그면 복사 불가");
eq((await call({ type: "OTP_REVEAL", id: a.id, password: PW })).code, "LOCKED", "잠그면 비밀키 보기 불가");
eq((await call({ type: "OTP_UNLOCK", password: "wrong" })).code, "WRONG_PASSWORD", "틀린 비밀번호");
eq((await call({ type: "OTP_UNLOCK", password: PW })).ok, true, "다시 해제");
// 만료
const s0 = session.data.get(store.S_OTP_SESSION);
session.data.set(store.S_OTP_SESSION, { ...s0, expiresAt: Date.now() - 1 });
eq((await call({ type: "OTP_LIST" })).code, "LOCKED", "만료되면 잠김");
eq(session.data.has(store.S_OTP_SESSION), false, "만료 세션 삭제");

console.log("마스터 비밀번호 변경 — 이 PC 에서");
await call({ type: "OTP_UNLOCK", password: PW });
await vault.changeMaster(PW, PW2);
eq((await call({ type: "OTP_REWRAP", oldPassword: PW, newPassword: PW2 })).result, "done", "DEK 다시 감싸기");
await call({ type: "OTP_LOCK" });
eq((await call({ type: "OTP_UNLOCK", password: PW })).code, "WRONG_PASSWORD", "이전 비밀번호로는 안 열림");
eq((await call({ type: "OTP_UNLOCK", password: PW2 })).ok, true, "새 비밀번호로 열림");
eq((await call({ type: "OTP_LIST" })).items.length, 3, "항목 그대로");

console.log("마스터 비밀번호 변경 — 다른 PC 에서 (이 PC 의 OTP 는 이전 비밀번호로 감싸져 있음)");
const PW3 = "third password 3";
await vault.changeMaster(PW2, PW3); // OTP_REWRAP 을 부르지 않음 = 다른 PC 에서 바꾼 상황
await call({ type: "OTP_LOCK" });
eq((await call({ type: "OTP_UNLOCK", password: PW3 })).code, "MASTER_CHANGED", "현재 비밀번호 → 옮기기 안내");
eq((await call({ type: "OTP_UNLOCK", password: PW2 })).code, "MASTER_CHANGED", "이전 비밀번호로도 바로 열지 않고 옮기기 안내");
eq((await call({ type: "OTP_MIGRATE_MASTER", oldPassword: "x", password: PW3 })).code, "WRONG_OLD", "이전 비밀번호가 틀리면 거부");
eq((await call({ type: "OTP_MIGRATE_MASTER", oldPassword: PW2, password: "x" })).code, "WRONG_PASSWORD", "현재 비밀번호가 틀리면 거부");
eq((await call({ type: "OTP_MIGRATE_MASTER", oldPassword: PW2, password: PW3 })).ok, true, "옮기기 성공 + 해제");
await call({ type: "OTP_LOCK" });
eq((await call({ type: "OTP_UNLOCK", password: PW3 })).ok, true, "이후 현재 비밀번호로 바로 열림");
eq((await call({ type: "OTP_LIST" })).items.length, 3, "항목 그대로");

console.log("삭제 / 자동 잠금 설정");
await call({ type: "OTP_DELETE", id: b.id });
eq((await call({ type: "OTP_LIST" })).items.length, 2, "삭제");
eq(local.data.has("ua_otp_e_" + b.id), false, "암호문도 삭제");
eq(store.normalizeOtpSettings({ autoLockMinutes: 15, maskCodes: false }), { autoLockMinutes: 30, maskCodes: false, clearClipboard: true }, "예전 15분 → 30분으로 올림");
eq(store.normalizeOtpSettings({ autoLockMinutes: 90 }).autoLockMinutes, 240, "90분 → 4시간으로 올림");
eq(store.normalizeOtpSettings({ autoLockMinutes: "x" }).autoLockMinutes, 30, "잘못된 값은 기본 30분");
await store.setOtpSettings({ autoLockMinutes: 60 });
await call({ type: "OTP_UNLOCK", password: PW3 });
eq(Math.round(((await call({ type: "OTP_STATUS" })).expiresAt - Date.now()) / 60000), 60, "1시간 잠금 적용");
await store.setOtpSettings({ autoLockMinutes: 240 });
await call({ type: "OTP_UNLOCK", password: PW3 });
eq(Math.round(((await call({ type: "OTP_STATUS" })).expiresAt - Date.now()) / 60000), 240, "4시간 잠금 적용");
eq(store.normalizeOtpSettings({ autoLockMinutes: 480 }).autoLockMinutes, 240, "4시간 초과는 4시간");

console.log(`\n${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
