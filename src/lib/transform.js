// 텍스트 변환 / 조합 순수 로직 (UI·크롬 API 의존 없음 → 단독 테스트 가능)

/**
 * 단일 규칙의 원본 텍스트에 변환 단계를 순서대로 적용한다.
 * @param {string} rawText
 * @param {object} rule  { transforms:[{find,replace,isRegex,flags}], trim:bool }
 * @returns {{ result:string, error:(string|null) }}
 */
export function applyTransforms(rawText, rule) {
  let text = rawText == null ? "" : String(rawText);
  const transforms = (rule && rule.transforms) || [];

  for (let i = 0; i < transforms.length; i++) {
    const t = transforms[i] || {};
    if (!t.find) continue; // 찾을 문자열이 없으면 건너뜀
    const replace = t.replace == null ? "" : String(t.replace);
    try {
      if (t.isRegex) {
        const flags = t.flags && t.flags.length ? t.flags : "g";
        const re = new RegExp(t.find, flags);
        text = text.replace(re, replace);
      } else {
        text = text.split(t.find).join(replace); // 리터럴 전체 치환
      }
    } catch (e) {
      return { result: text, error: `변환 ${i + 1}: ${e.message}` };
    }
  }

  if (rule && rule.trim) text = text.trim();
  return { result: text, error: null };
}

const SEPARATORS = {
  none: "",
  space: " ",
  newline: "\n",
  tab: "\t",
  comma: ", ",
};

/** 구분자 키 → 실제 문자열 */
export function separatorValue(combine) {
  if (!combine) return "";
  if (combine.separator === "custom") return combine.customSep || "";
  return SEPARATORS[combine.separator] != null ? SEPARATORS[combine.separator] : "";
}

/**
 * 여러 규칙의 결과를 조합한다.
 * @param {Array<{result:string, enabled:boolean}>} computed  각 규칙의 계산된 결과(순서 유지)
 * @param {object} combine  { mode:'join'|'template', separator, customSep, template }
 * @returns {string}
 */
export function combineResults(computed, combine) {
  const mode = (combine && combine.mode) || "join";

  if (mode === "template") {
    const tpl = (combine && combine.template) || "";
    // {1}, {2} ... (1-based, 전체 규칙 순서 기준). 비활성 규칙은 빈 문자열.
    return tpl.replace(/\{(\d+)\}/g, (m, n) => {
      const idx = parseInt(n, 10) - 1;
      const item = computed[idx];
      if (!item) return "";
      return item.enabled === false ? "" : item.result;
    });
  }

  // join 모드: 활성 규칙만 구분자로 연결
  const sep = separatorValue(combine);
  return computed
    .filter((c) => c && c.enabled !== false)
    .map((c) => c.result)
    .join(sep);
}
