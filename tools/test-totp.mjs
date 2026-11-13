// OTP 계산·형식 해석 검증 (node tools/test-totp.mjs)
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  cleanSecret,
  groupSecret,
  hotp,
  normalizeEntry,
  parseImportText,
  parseMigrationUri,
  parseOtpauthUri,
  totp,
} from "../src/lib/totp.js";

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
async function throws(fn, label, re) {
  try {
    await fn();
    fail++;
    console.log(`  ✗ ${label} (예외가 나지 않음)`);
  } catch (e) {
    if (re && !re.test(e.message)) {
      fail++;
      console.log(`  ✗ ${label} (메시지: ${e.message})`);
    } else {
      pass++;
      console.log(`  ✓ ${label}`);
    }
  }
}

const ascii = (s) => base32Encode(new TextEncoder().encode(s));

console.log("Base32");
eq(base32Encode(new TextEncoder().encode("foobar")), "MZXW6YTBOI", "RFC 4648: foobar");
eq(new TextDecoder().decode(base32Decode("MZXW6YTBOI======")), "foobar", "패딩 포함 디코딩");
eq(new TextDecoder().decode(base32Decode("mzxw 6ytb-oi")), "foobar", "소문자·공백·하이픈 허용");
eq(cleanSecret(" ab cd= "), "ABCD", "cleanSecret");
eq(groupSecret("JBSWY3DPEHPK3PXP"), "JBSW Y3DP EHPK 3PXP", "4글자씩 묶기");
await throws(() => base32Decode("ABC1"), "잘못된 글자 거부", /쓸 수 없는/);
await throws(() => base32Decode("  "), "빈 비밀키 거부", /비어/);

console.log("HOTP (RFC 4226 부록 D)");
const rfcKey = ascii("12345678901234567890");
const hotpExpect = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
for (let i = 0; i < 10; i++) eq(await hotp(rfcKey, i), hotpExpect[i], `counter ${i}`);

console.log("TOTP (RFC 6238 부록 B, 8자리)");
const k1 = ascii("12345678901234567890");
const k256 = ascii("12345678901234567890123456789012");
const k512 = ascii("1234567890123456789012345678901234567890123456789012345678901234");
const vectors = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];
for (const [t, s1, s256, s512] of vectors) {
  const at = t * 1000;
  eq((await totp({ secret: k1, algorithm: "SHA1", digits: 8, period: 30 }, at)).code, s1, `SHA1 t=${t}`);
  eq((await totp({ secret: k256, algorithm: "SHA256", digits: 8, period: 30 }, at)).code, s256, `SHA256 t=${t}`);
  eq((await totp({ secret: k512, algorithm: "SHA512", digits: 8, period: 30 }, at)).code, s512, `SHA512 t=${t}`);
}
const r = await totp({ secret: k1, algorithm: "SHA1", digits: 6, period: 30 }, 59000);
eq([r.code, r.remaining, r.validUntil], ["287082", 1, 60000], "6자리·남은 시간·유효 기한");

console.log("항목 정규화");
eq(
  normalizeEntry({ issuer: " GitHub ", account: "me", secret: "jbsw y3dp ehpk 3pxp" }),
  { issuer: "GitHub", account: "me", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 },
  "기본값 채우기·정리"
);
await throws(() => normalizeEntry({ issuer: "x", secret: "AAAA" }), "너무 짧은 비밀키", /짧/);
await throws(() => normalizeEntry({ issuer: "x", secret: "JBSWY3DPEHPK3PXP", algorithm: "MD5" }), "MD5 거부", /알고리즘/);
await throws(() => normalizeEntry({ issuer: "x", secret: "JBSWY3DPEHPK3PXP", digits: 4 }), "4자리 거부", /자릿수/);
await throws(() => normalizeEntry({ secret: "JBSWY3DPEHPK3PXP" }), "이름 없음 거부", /이름/);

console.log("otpauth:// URI");
eq(
  parseOtpauthUri("otpauth://totp/ACME%20Co:john.doe@email.com?secret=HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ&issuer=ACME%20Co&algorithm=SHA1&digits=6&period=30"),
  { issuer: "ACME Co", account: "john.doe@email.com", secret: "HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ", algorithm: "SHA1", digits: 6, period: 30 },
  "Google Key URI 예시"
);
eq(parseOtpauthUri("otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP").issuer, "Example", "issuer 파라미터 없으면 라벨에서");
eq(parseOtpauthUri("otpauth://totp/alice?secret=JBSWY3DPEHPK3PXP&issuer=Svc&digits=8&period=60&algorithm=SHA256").digits, 8, "자릿수 8");
await throws(() => parseOtpauthUri("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=0"), "HOTP 거부", /HOTP/);
await throws(() => parseOtpauthUri("https://example.com"), "형식 아님", /형식/);
const e1 = { issuer: "ACME Co", account: "john@x.com", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA256", digits: 8, period: 60 };
eq(parseOtpauthUri(buildOtpauthUri(e1)), e1, "build → parse 왕복");
eq(buildOtpauthUri({ issuer: "A", account: "b", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 }),
  "otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP&issuer=A", "기본값은 생략");

console.log("Google OTP 내보내기 (otpauth-migration)");
// protobuf 직접 조립
const enc = new TextEncoder();
const varint = (n) => {
  const out = [];
  while (n > 127) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
};
const fieldBytes = (no, bytes) => [...varint((no << 3) | 2), ...varint(bytes.length), ...bytes];
const fieldInt = (no, v) => [...varint(no << 3), ...varint(v)];
const otpParams = ({ secret, name, issuer, alg = 1, digits = 1, type = 2 }) => [
  ...fieldBytes(1, secret),
  ...fieldBytes(2, [...enc.encode(name)]),
  ...(issuer ? fieldBytes(3, [...enc.encode(issuer)]) : []),
  ...fieldInt(4, alg),
  ...fieldInt(5, digits),
  ...fieldInt(6, type),
];
const sec1 = [...base32Decode("JBSWY3DPEHPK3PXP")];
const sec2 = [...new TextEncoder().encode("12345678901234567890")];
const payload = [
  ...fieldBytes(1, otpParams({ secret: sec1, name: "alice@google.com", issuer: "Google" })),
  ...fieldBytes(1, otpParams({ secret: sec2, name: "GitHub:bob", issuer: "", alg: 2, digits: 2 })),
  ...fieldBytes(1, otpParams({ secret: sec1, name: "counter", issuer: "Old", type: 1 })),
  ...fieldInt(2, 1),
  ...fieldInt(3, 2),
  ...fieldInt(4, 0),
  ...fieldInt(5, 12345),
];
const b64 = Buffer.from(Uint8Array.from(payload)).toString("base64");
const migUri = `otpauth-migration://offline?data=${encodeURIComponent(b64)}`;
const mig = parseMigrationUri(migUri);
eq(mig.entries.length, 2, "TOTP 2개 읽음");
eq(mig.entries[0], { issuer: "Google", account: "alice@google.com", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 }, "첫 항목");
eq([mig.entries[1].issuer, mig.entries[1].account, mig.entries[1].algorithm, mig.entries[1].digits], ["GitHub", "bob", "SHA256", 8], "이름에서 issuer 분리 · SHA256 · 8자리");
eq(mig.skipped, [{ label: "Old · counter", reason: "HOTP(카운터 방식)는 지원하지 않아요" }], "HOTP 는 건너뜀");
eq(mig.batch, { index: 0, size: 2 }, "QR 묶음 정보");
eq(parseMigrationUri(`otpauth-migration://offline?data=${b64}`).entries.length, 2, "인코딩 안 된 '+' 도 허용");
await throws(() => parseMigrationUri("otpauth-migration://offline?data=%%%"), "깨진 데이터 거부");
await throws(() => parseMigrationUri("otpauth-migration://offline?data=" + encodeURIComponent(Buffer.from([0x0a, 0x50, 1]).toString("base64"))), "잘린 데이터 거부", /잘렸/);

console.log("붙여넣기 해석");
const mixed = parseImportText(`메모\n${migUri}\n otpauth://totp/X:y?secret=JBSWY3DPEHPK3PXP \notpauth://hotp/z?secret=JBSWY3DPEHPK3PXP`);
eq([mixed.entries.length, mixed.skipped.length, mixed.batch], [3, 2, { index: 0, size: 2 }], "여러 줄·혼합");
await throws(() => parseImportText("아무 글"), "OTP 정보 없음", /아니에요/);

console.log(`\n${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
