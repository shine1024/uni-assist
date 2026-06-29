// URL 허용 패턴 매칭 (UI·크롬 API 비의존 → 단독 테스트 가능)

/**
 * 패턴 문자열을 정규식으로 변환. `*` 는 임의 문자열(.*) 로 처리하고,
 * URL 시작(^)에서부터 매칭한다(접두어 매칭). 끝은 고정하지 않음.
 * 예) "https://labdev.unipost.co.kr/redmine" → /redmine, /redmine/issues/1 등 모두 매칭.
 */
function patternToRegExp(pattern) {
  const escaped = String(pattern)
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // 정규식 특수문자 이스케이프
    .replace(/\*/g, ".*"); // 와일드카드만 복원
  return new RegExp("^" + escaped);
}

/**
 * url 이 patterns 중 하나라도 만족하면 true.
 * @param {string} url
 * @param {string[]} patterns  한 줄당 하나의 패턴(공백/빈 줄 무시)
 */
export function urlMatches(url, patterns) {
  if (!url || !Array.isArray(patterns)) return false;
  for (const p of patterns) {
    const pat = (p || "").trim();
    if (!pat) continue;
    try {
      if (patternToRegExp(pat).test(url)) return true;
    } catch (_) {
      // 잘못된 패턴은 건너뜀
    }
  }
  return false;
}

/** 줄 단위 텍스트 → 패턴 배열 */
export function parsePatterns(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
