# 구조 설명 (ARCHITECTURE)

확장의 동작 원리와 컴포넌트 간 통신을 정리한 문서. 다음 세션에서 빠르게 맥락을 잡기 위한 용도.

## 컴포넌트

| 컴포넌트 | 파일 | 역할 |
|---|---|---|
| 매니페스트 | `manifest.json` | MV3 설정. 권한, 사이드 패널 경로, 아이콘 |
| 서비스 워커 | `src/background/service-worker.js` | 사이드 패널 열기 + **단축키→추출·조합·복사** (ES 모듈) |
| 사이드 패널 | `src/sidepanel/*` | UI + 상태 관리 + 추출/변환/조합/복사/프리셋/단축키 설정 (컨트롤러) |
| 콘텐츠 스크립트 | `src/content/picker.js`, `picker.css` | 요소 선택·하이라이트·텍스트 추출·페이지 토스트 |
| 오프스크린 | `src/offscreen/*` | 서비스 워커 대신 클립보드에 복사(`CLIPBOARD` 사유) |
| 순수 로직 | `src/lib/transform.js`, `src/lib/match.js` | 변환·조합 / URL 패턴 매칭. 크롬 API 비의존 → 테스트 용이 |

## 권한 (manifest)
- `sidePanel` — 사이드 패널 사용
- `scripting` + `host_permissions: <all_urls>` — 콘텐츠 스크립트를 필요 시 주입
- `storage` — 작업 상태/프리셋/허용 패턴 저장
- `tabs`, `activeTab` — 활성 탭 조회/메시지 전송
- `offscreen` + `clipboardWrite` — 서비스 워커에서 클립보드 복사(오프스크린 문서)
- `commands` (매니페스트 키) — 단축키 `copy-combined`

## 통신 흐름

```
[사이드 패널]                         [콘텐츠 스크립트(picker.js)]
  ＋요소 선택
   └ chrome.scripting.insertCSS/executeScript  → (주입, 중복 가드)
   └ tabs.sendMessage {START_PICK, ruleId}     → 선택 모드 진입(호버/클릭)
                                                  클릭 시 셀렉터 생성 + 추출
   onMessage {ELEMENT_PICKED, selector, text} ← runtime.sendMessage
   → 규칙에 반영, 재렌더

  ↻ 재추출
   └ tabs.sendMessage {EXTRACT, selector, ...} → querySelector 후 값 반환
   ← sendResponse {found, rawText}
```

- 선택 결과(콘텐츠→패널)는 `chrome.runtime.sendMessage`(브로드캐스트), 재추출 응답은 `tabs.sendMessage`의 응답 콜백 사용.
- 콘텐츠 스크립트는 항상 주입하지 않고, 동작이 필요한 순간에만 주입. `window.__uaPickerLoaded`로 리스너 중복 등록 방지.

## 단축키 복사 흐름 (특정 사이트 전용)

```
[사용자가 단축키 누름]
  → chrome.commands.onCommand (service-worker)
     ├ 활성 탭 URL 조회
     ├ urlMatches(url, allowedPatterns)  ← 허용 사이트 아니면 즉시 종료(아무 동작 X)
     ├ storage.local.current(규칙/조합) 로드
     ├ ensurePicker(tab) → tabs.sendMessage {EXTRACT_ALL, rules[]} → {values}
     ├ applyTransforms + combineResults  (transform.js 재사용)
     ├ offscreen 문서 생성/재사용 → COPY_TO_CLIPBOARD → 클립보드 복사
     └ tabs.sendMessage {TOAST,"복사됨 ✓"} + action 배지 ✓
```

- 단축키는 매니페스트 `commands.copy-combined`(기본 `Ctrl+Shift+Y`). 전역이지만 **URL 패턴으로 게이트**해 "특정 사이트에서만" 충족.
- 허용 패턴: `storage.local.allowedPatterns`(사이드 패널에서 편집). 매칭은 `src/lib/match.js`(접두어 + `*` 와일드카드).
- 클립보드: 서비스 워커는 DOM/포커스가 없어 직접 복사 불가 → `offscreen` 문서에서 `textarea`+`execCommand('copy')`.

## 셀렉터 전략 (`buildSelector`)
1. 조상 중 `id`가 있으면 `#id`를 앵커로 사용하고 거기서 멈춤.
2. 그 외에는 `tag` + (형제 중 같은 태그가 여럿일 때) `:nth-of-type(n)`을 누적해 경로 생성.
3. 같은 셀렉터가 여러 요소에 매칭되면, 선택 시점의 `index`(매칭 목록 내 위치)로 구분해 재추출 시 동일 요소를 찾음.
4. 한계: 동적으로 구조가 크게 바뀌는 SPA에서는 셀렉터가 깨질 수 있음 → `다시 선택`으로 갱신.

## 데이터 모델

```js
state = {
  rules: [{
    id, name, selector, index, source,        // source: innerText|textContent|value|attr
    attrName, rawText, trim, enabled,
    transforms: [{ find, replace, isRegex, flags }]  // 순서대로 적용
  }],
  combine: { mode, separator, customSep, template }   // mode: join|template
}
```
- `chrome.storage.local.current` = 현재 작업 상태(자동 저장, 패널 다시 열면 복원)
- `chrome.storage.local.presets` = 저장된 프리셋 배열
- `chrome.storage.local.allowedPatterns` = 단축키가 동작할 허용 URL 패턴 배열

## 조합 규칙
- `join`: `enabled`인 규칙 결과를 구분자로 연결.
- `template`: `{1}`,`{2}`… = 전체 규칙 순서 기준 1-based 결과 치환. 비활성 규칙은 빈 문자열.
