// 사이트별 텍스트 추출 규칙 테스트
// 실행: node tools/test-site-rules.mjs
import {
  DEFAULT_COMBINE,
  countSiteRules,
  migrateLegacy,
  normalizeSiteState,
  putSiteState,
  siteKeyFromUrl,
} from "../src/lib/site-rules.js";

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

console.log("사이트 키");
eq(siteKeyFromUrl("https://labdev.unipost.co.kr/redmine/issues/1"), "labdev.unipost.co.kr", "호스트");
eq(siteKeyFromUrl("http://127.0.0.1:8080/a"), "127.0.0.1:8080", "포트 포함");
eq(siteKeyFromUrl("file:///C:/a.html"), "file", "file 은 하나로");
eq(siteKeyFromUrl("chrome://extensions"), null, "chrome:// 불가");
eq(siteKeyFromUrl(""), null, "빈 값");
eq(siteKeyFromUrl(undefined), null, "undefined");

console.log("저장 형태");
eq(normalizeSiteState(undefined), { rules: [], combine: DEFAULT_COMBINE }, "없음 → 빈 묶음");
eq(normalizeSiteState({ rules: [1], combine: { separator: "newline" } }).combine.separator, "newline", "조합 설정 유지");
eq(putSiteState({ b: 1 }, "a", { rules: [{ id: 1 }] }), { b: 1, a: { rules: [{ id: 1 }], combine: DEFAULT_COMBINE } }, "추가");
eq(putSiteState({ a: { rules: [1] }, b: 1 }, "a", { rules: [] }), { b: 1 }, "규칙이 없으면 항목 삭제");
eq(putSiteState({ b: 1 }, null, { rules: [1] }), { b: 1 }, "키 없으면 그대로");
eq(countSiteRules({ a: { rules: [1, 2] }, b: { rules: [3] }, c: null }), 3, "규칙 수 합계");

console.log("예전 데이터 옮기기");
const legacy = { rules: [{ id: "r1" }], combine: { separator: "comma" } };
const id = () => "p1";
eq(migrateLegacy({ siteRules: {}, current: legacy }, id), null, "이미 옮겼으면 null");
eq(migrateLegacy({ current: undefined }, id), { siteRules: {} }, "예전 규칙 없음 → 빈 저장소");
eq(
  migrateLegacy({ current: legacy, allowedPatterns: ["https://labdev.unipost.co.kr/redmine"] }, id),
  { siteRules: { "labdev.unipost.co.kr": { rules: legacy.rules, combine: { ...DEFAULT_COMBINE, separator: "comma" } } } },
  "첫 허용 사이트로 옮김"
);
eq(
  Object.keys(migrateLegacy({ current: legacy, allowedPatterns: ["https://*.example.com/*", "https://b.com/x/*"] }, id).siteRules),
  ["b.com"],
  "호스트 와일드카드 패턴은 건너뛰고 다음 패턴"
);
eq(
  migrateLegacy({ current: legacy, allowedPatterns: [], presets: [{ id: "a" }] }, id),
  { siteRules: {}, presets: [{ id: "a" }, { id: "p1", name: "이전 규칙", rules: legacy.rules, combine: { ...DEFAULT_COMBINE, separator: "comma" } }] },
  "사이트를 모르면 「이전 규칙」 프리셋으로"
);

console.log(`\n${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
