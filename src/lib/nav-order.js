// 사이드 패널 메뉴(탭) 순서 — 드래그로 바꾼 순서를 저장한다.
// 크롬 API 비의존 → 단위 테스트 가능 (tools/test-nav-order.mjs)
//
// storage.sync 에 `ua_` 접두사로 저장 → PC 간 동기화되고 백업(backup.js 의 SYNC_PREFIX)에도 자동 포함된다.
export const K_NAV_ORDER = "ua_nav_order"; // ["extract", "login", ...]

/**
 * 저장된 순서를 현재 메뉴 목록에 맞춘다.
 * - 모르는 값·중복은 버리고, 저장 이후 새로 생긴 메뉴는 기본 순서 위치대로 뒤에 붙인다.
 */
export function normalizeOrder(saved, views) {
  const out = [];
  if (Array.isArray(saved)) {
    for (const v of saved) if (views.includes(v) && !out.includes(v)) out.push(v);
  }
  for (const v of views) if (!out.includes(v)) out.push(v);
  return out;
}

/** `item` 을 `target` 의 앞(before=true) 또는 뒤로 옮긴 새 배열 */
export function moveItem(order, item, target, before) {
  if (item === target || !order.includes(item) || !order.includes(target)) return order.slice();
  const rest = order.filter((v) => v !== item);
  const i = rest.indexOf(target) + (before ? 0 : 1);
  rest.splice(i, 0, item);
  return rest;
}
