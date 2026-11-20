// 데이터 지우기 — 설정 → 데이터 지우기
//
// 크롬 동기화가 켜진 상태에서 storage.sync 를 지우면 그 삭제도 동기화되어
// 다른 PC 와 구글 서버에서도 지워진다. 확장은 동기화가 켜져 있는지 확실히 알 수 없으므로
// 두 단계로 나눈다.
//   - "device": 이 PC 에만 있는 데이터(local + session). 동기화 데이터는 건드리지 않는다.
//   - "all":    위 + 동기화 데이터(sync). 다른 PC 에도 영향이 갈 수 있다.

export const WIPE_DEVICE = "device";
export const WIPE_ALL = "all";
export const RESET_CONFIRM_WORD = "초기화";

/**
 * @param {{ sync: any, local: any, session: any }} areas chrome.storage 영역들 (clear() 만 쓴다)
 * @param {"device"|"all"} scope
 */
export async function wipeStorage(areas, scope) {
  if (scope !== WIPE_DEVICE && scope !== WIPE_ALL) throw new Error("알 수 없는 범위: " + scope);
  await areas.session.clear();
  await areas.local.clear();
  if (scope === WIPE_ALL) await areas.sync.clear();
}

export function isResetConfirmed(input) {
  return typeof input === "string" && input.trim() === RESET_CONFIRM_WORD;
}
