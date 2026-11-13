// 메뉴 순서 테스트
// 실행: node tools/test-nav-order.mjs
import { moveItem, normalizeOrder } from "../src/lib/nav-order.js";

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

const V = ["extract", "login", "approval", "settings"];

eq(normalizeOrder(undefined, V), V, "저장값 없음 → 기본 순서");
eq(normalizeOrder("x", V), V, "배열 아님 → 기본 순서");
eq(normalizeOrder(["settings", "extract", "login", "approval"], V), ["settings", "extract", "login", "approval"], "저장 순서 유지");
eq(normalizeOrder(["settings", "gone", "settings", "login"], V), ["settings", "login", "extract", "approval"], "모르는 값·중복 제거, 빠진 메뉴는 뒤에");

eq(moveItem(V, "settings", "extract", true), ["settings", "extract", "login", "approval"], "맨 앞으로");
eq(moveItem(V, "extract", "settings", false), ["login", "approval", "settings", "extract"], "맨 뒤로");
eq(moveItem(V, "extract", "approval", true), ["login", "extract", "approval", "settings"], "가운데 앞에");
eq(moveItem(V, "login", "login", true), V, "자기 자신 → 그대로");
eq(moveItem(V, "nope", "login", true), V, "모르는 항목 → 그대로");


console.log(`\n${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
