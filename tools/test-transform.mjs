// 순수 로직 검증 (node tools/test-transform.mjs) — transform.js + match.js
import { applyTransforms, combineResults, separatorValue } from "../src/lib/transform.js";
import { urlMatches, parsePatterns } from "../src/lib/match.js";

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

console.log("applyTransforms");
// 리터럴 치환: "일감" 제거
eq(applyTransforms("일감홍길동", { transforms: [{ find: "일감", replace: "" }], trim: true }).result, "홍길동", "리터럴 '일감' 제거");
// 정규식: 앞쪽 '일감 ' 접두어 제거
eq(
  applyTransforms("일감 PROJ-123", { transforms: [{ find: "^일감\\s*", replace: "", isRegex: true, flags: "" }], trim: true }).result,
  "PROJ-123",
  "정규식 접두어 제거"
);
// 정규식 캡처 그룹 사용
eq(
  applyTransforms("주문번호: 4567", { transforms: [{ find: ".*?(\\d+)", replace: "$1", isRegex: true, flags: "" }], trim: true }).result,
  "4567",
  "정규식 캡처 그룹"
);
// 변환 여러 단계 + trim
eq(
  applyTransforms("  [긴급] 일감: 배포  ", {
    transforms: [
      { find: "[긴급]", replace: "" },
      { find: "일감:", replace: "" },
    ],
    trim: true,
  }).result,
  "배포",
  "다단계 변환 + trim"
);
// 잘못된 정규식 → error 반환
eq(applyTransforms("x", { transforms: [{ find: "(", replace: "", isRegex: true }] }).error != null, true, "잘못된 정규식 에러 처리");

console.log("separatorValue");
eq(separatorValue({ separator: "newline" }), "\n", "줄바꿈 구분자");
eq(separatorValue({ separator: "custom", customSep: " / " }), " / ", "커스텀 구분자");

console.log("combineResults");
const computed = [
  { result: "홍길동", enabled: true },
  { result: "PROJ-123", enabled: true },
  { result: "무시됨", enabled: false },
];
// join (비활성 제외)
eq(combineResults(computed, { mode: "join", separator: "space" }), "홍길동 PROJ-123", "join: 활성만 공백 연결");
// template (1-based, 비활성은 빈칸)
eq(combineResults(computed, { mode: "template", template: "[{2}] {1}" }), "[PROJ-123] 홍길동", "template: 순서 재배치");
eq(combineResults(computed, { mode: "template", template: "{1}/{3}" }), "홍길동/", "template: 비활성 규칙은 빈 문자열");

// 예시 시나리오: 1번(일감 제거) + 2번 조합
console.log("시나리오: 일감 제거 후 조합");
const r1 = applyTransforms("일감배포작업", { transforms: [{ find: "일감", replace: "" }], trim: true }).result;
const r2 = applyTransforms("2026-06-29", { transforms: [], trim: true }).result;
eq(combineResults([{ result: r1, enabled: true }, { result: r2, enabled: true }], { mode: "join", separator: "space" }), "배포작업 2026-06-29", "요구사항 예시 조합");

console.log("urlMatches (단축키 사이트 게이트)");
const P = ["https://labdev.unipost.co.kr/redmine"];
eq(urlMatches("https://labdev.unipost.co.kr/redmine", P), true, "정확히 일치");
eq(urlMatches("https://labdev.unipost.co.kr/redmine/issues/123", P), true, "하위 경로 접두어 일치");
eq(urlMatches("https://labdev.unipost.co.kr/", P), false, "redmine 아닌 경로 불일치");
eq(urlMatches("https://other.unipost.co.kr/redmine", P), false, "다른 호스트 불일치");
eq(urlMatches("https://labdev.unipost.co.kr/redmine", []), false, "패턴 없음 → 항상 불일치");
eq(urlMatches("https://a.com/x/y", ["https://a.com/*/y"]), true, "와일드카드 중간 매칭");
eq(parsePatterns("  a \n\n b \n"), ["a", "b"], "parsePatterns: 트림/빈 줄 제거");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
