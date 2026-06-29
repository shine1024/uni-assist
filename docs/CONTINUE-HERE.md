# ▶ 여기서 이어서 시작하세요 (CONTINUE-HERE)

> 작업 세션이 끊겼다 다시 시작할 때 **가장 먼저 읽는 파일**입니다.
> 이 파일 하나만 보면 "지금 어디까지 됐고, 다음에 뭘 하면 되는지" 알 수 있도록 항상 최신으로 유지합니다.
> (세션을 마칠 때 아래 3개 섹션 — 현재 상태 / 다음 할 일 / 메모 — 를 갱신하세요.)

---

## 📌 한 줄 요약
크롬 사이드 패널 확장 **"Uni-Assist 도우미"** (다기능 예정). 첫 기능 "텍스트 추출" — 요소 다중 선택 → 정규식 변환 → 조합 → 복사, + 허용 사이트 전용 단축키 복사. **v0.2.1.**

## ✅ 현재 상태 (last updated: 2026-06-29)
- MV3 확장 골격 + 사이드 패널 UI 완성 (`manifest.json`, `src/**`)
- 요소 클릭 선택 / 다중 규칙 / 다단계 정규식 변환 / 연결·템플릿 조합 / 복사 동작
- 프리셋 저장·불러오기, 작업 상태 자동 저장(chrome.storage.local)
- **단축키 복사**: `copy-combined`(기본 Ctrl+Shift+Y) → 허용 사이트(기본 redmine)에서만 재추출·조합·복사 + 페이지 토스트. SW(ES모듈) + offscreen 문서로 클립보드 복사.
- 순수 로직 단위 테스트 통과 (`node tools/test-transform.mjs` → 18/18: transform + match)
- 아이콘 생성기(`tools/make_icons.py`)로 16/48/128 PNG 생성 완료
- ⚠ 아직 **실제 크롬에 로드해 수동 검증(요소 선택 흐름 + 단축키 복사)은 안 함** → 다음 세션 1순위

## 🎯 다음 할 일 (우선순위 순)
1. **수동 검증**: `chrome://extensions`에 로드 → 요소 선택/추출/조합/복사, 그리고 redmine에서 단축키 복사 확인
   - 매니페스트 바뀌었으니 확장 **새로고침** 필수. 단축키 충돌 시 `chrome://extensions/shortcuts`에서 지정.
   - iframe 내부 요소, SPA(동적 DOM), 셀렉터 안정성 점검
2. 선택한 요소를 패널에서 **호버하면 페이지에서 하이라이트** 되돌려주는 기능(역방향 강조)
3. 규칙 **드래그 앤 드롭 정렬** (현재는 ↑/↓ 버튼)
4. 프리셋/허용패턴 **내보내기·가져오기(JSON)** — 다른 PC와 공유
5. 추출 결과 **히스토리**(최근 복사한 결과 N개) 보관
6. (단축키) 사이트별로 **다른 프리셋 자동 적용** 검토

## 🧠 메모 / 결정사항 (왜 이렇게 했는지)
- UI 형태: **사이드 패널** 채택 (팝업은 페이지 클릭 시 닫혀 요소 선택 워크플로와 안 맞음).
- 콘텐츠 스크립트는 매니페스트 상시 주입이 아니라 **필요 시 `chrome.scripting`으로 주입**(중복 주입 가드 `window.__uaPickerLoaded`).
- 셀렉터는 id 우선 → `tag:nth-of-type()` 경로. 같은 셀렉터에 여러 개 매칭 시 `index`로 구분.
- 변환은 규칙당 **순서 있는 단계 배열**(리터럴/정규식 혼용). 잘못된 정규식은 결과 대신 에러 메시지 표시.
- `chrome://`, 웹스토어 등 주입 불가 페이지는 토스트로 안내하고 동작 막음.
- 단축키는 `commands` API(전역) + **URL 패턴 게이트**로 "특정 사이트 전용"을 구현(`src/lib/match.js`). 허용 패턴은 `storage.local.allowedPatterns`.
- 서비스 워커는 클립보드 직접 접근이 안 되므로 **offscreen 문서 + textarea/execCommand** 로 복사(크롬 공식 패턴).

## 🔁 작업 루틴
- 시작: 이 파일 읽기 → 필요하면 `docs/sessions/`의 최근 세션 로그 확인
- 마칠 때: `docs/sessions/`에 새 세션 로그 작성(`_TEMPLATE.md` 복사) → 이 파일의 상태/다음할일 갱신 → `docs/DEVLOG.md`에 한 줄 추가
- 코드 바꾸면: `node tools/test-transform.mjs` 로 회귀 확인

## 🔗 바로가기
- 전체 이력: [`DEVLOG.md`](DEVLOG.md)
- 구조 설명: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- 세션 기록: [`sessions/`](sessions/) · 새 세션은 [`sessions/_TEMPLATE.md`](sessions/_TEMPLATE.md) 복사
