# 구조 설명 (ARCHITECTURE)

확장의 동작 원리와 컴포넌트 간 통신을 정리한 문서. 다음 세션에서 빠르게 맥락을 잡기 위한 용도.

## 컴포넌트

| 컴포넌트 | 파일 | 역할 |
|---|---|---|
| 매니페스트 | `manifest.json` | MV3 설정. 권한, 사이드 패널 경로, 아이콘, 단축키 2종 |
| 서비스 워커 | `src/background/service-worker.js` | 사이드 패널 열기 + **단축키→추출·조합·복사** + **단축키→자동 로그인** (ES 모듈) |
| 사이드 패널 | `src/sidepanel/sidepanel.*` | 메뉴 전환 + 텍스트 추출 컨트롤러(상태·변환·조합·복사·프리셋·단축키 설정) |
| 사이드 패널(로그인) | `src/sidepanel/login.js` | **자동 로그인 화면 컨트롤러** — 잠금/해제, 사이트·계정 CRUD, 셀렉터 선택, 보안·동기화 설정 |
| 콘텐츠 스크립트 | `src/content/picker.js`, `picker.css` | 요소 선택·하이라이트·텍스트 추출·페이지 토스트 (두 기능 공용) |
| 콘텐츠 스크립트(로그인) | `src/content/autofill.js`, `autofill.css` | **자동 로그인/로그아웃 전용** — 상태 판별·값 주입·버튼 클릭·계정 선택 오버레이 |
| 콘텐츠 스크립트(단축키) | `src/content/hotkey.js` | **페이지 내 단축키** 수신 — `F2`(로그인/로그아웃), `F4`(패널 토글). 동적 등록(상주) |
| 2차 인증 OTP | `src/background/approval*.js`, `src/lib/approval-flow.js`, `approval-config.js`, `src/sidepanel/approval.js` | 호스트 포트(크롬 비의존) + 크롬 연결부 + 셀렉터 + 패널 화면 |
| 네이티브 호스트 | `host/*` | Chrome 이 실행하는 Node 프로그램. POP3 인증번호 조회, OS 키체인 읽기 |
| 오프스크린 | `src/offscreen/*` | 서비스 워커 대신 클립보드에 복사(`CLIPBOARD` 사유) |
| 순수 로직 | `src/lib/transform.js`, `match.js`, `crypto.js`, `login-match.js`, `hotkey.js` | 변환·조합 / 복사용 URL 패턴 / 암·복호 / 로그인용 origin·경로 매칭·매치 패턴 / 키 조합 정규화. 크롬 API 비의존 → 테스트 용이 |
| 크롬 의존 로직 | `src/lib/login-store.js`, `vault.js`, `tabs.js` | sync 저장(분할) / 마스터 비밀번호·잠금 세션 / 탭·주입 헬퍼 |

## 권한 (manifest)
- `sidePanel` — 사이드 패널 사용
- `scripting` + `host_permissions: <all_urls>` — 콘텐츠 스크립트를 필요 시 주입
- `storage` — 작업 상태/프리셋/허용 패턴 저장
- `tabs`, `activeTab` — 활성 탭 조회/메시지 전송
- `offscreen` + `clipboardWrite` — 서비스 워커에서 클립보드 복사(오프스크린 문서)
- `commands` (매니페스트 키) — 단축키 `copy-combined`, `auto-login` (전역)
- 페이지 내 단축키(F2)는 권한 없이 `scripting` + 기존 `host_permissions` 로 동적 등록

> 자동 로그인은 **새 권한을 추가하지 않는다.** 기존 `storage`(+`storage.session`은 추가 권한 불필요),
> `scripting`, `tabs`/`activeTab`, `host_permissions` 만으로 구현했다(최소 권한 원칙).

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

## 자동 로그인 / 로그아웃 흐름

```
[사용자가 Ctrl+Shift+L]
  → chrome.commands.onCommand ("auto-login") → runAutoLogin()
     ├ 활성 탭 URL이 http(s)인지 확인            ← chrome:// 등은 즉시 종료
     ├ vault.acquireRunLock()                    ← storage.session 기반, 6초 내 중복 실행 차단
     ├ loadSites()  (storage.sync, 사이트당 1항목)
     ├ 매칭을 **두 벌** 만든다
     │    · matches       = findMatchingSites(url, sites)        ← 로그인용: origin + 경로 경계 일치
     │    · originMatches = findOriginMatchingSites(url, sites)  ← 로그아웃용: origin 만 일치
     │      (로그인은 특정 경로에서 하지만 로그아웃은 로그인 후 아무 경로에서나 누른다.
     │       경로 일치를 요구하면 "등록되지 않은 사이트"로 보여 로그아웃이 불가능해진다.
     │       로그아웃은 복호화를 하지 않으므로 origin 일치만으로도 자격증명 유출 위험이 없다)
     │    └ 둘 다 비면 findDowngradedSites() 로 HTTPS→HTTP 접속을 구분해 안내
     ├ vault.getUnlockedKey()
     │    └ 잠김 → setPending(tab,url) + sidePanel.open() 시도 + 페이지 토스트 안내 → 종료
     ├ ensureAutofill(tab) : picker.css + autofill.css/js 를 **frameIds:[0]** 에만 주입
     │
     ├ ❶ 로그아웃 분기 (잠금 해제 불필요 — 복호화가 없다)
     │    logoutCandidates(originMatches) 각각에 AF_DETECT
     │      └ 로그아웃 셀렉터 요소가 **DOM 에 있으면** 로그인 상태로 보고 AF_LOGOUT → 클릭 → 종료
     │         (드롭다운에 숨은 링크도 다루려고 표시 여부는 보지 않는다)
     │
     ├ ❷ 로그인 분기
     ├ matches 가 비었는데 originMatches 는 있다 → PATH_MISMATCH 로 원인 안내 후 종료
     │    ("경로 /x 에서만 로그인하도록 등록돼 있어요 — '경로까지 일치'를 끄거나 URL을 고치세요")
     ├ accountCandidates(matches)                ← 기본 계정을 맨 앞으로 **정렬만** 한다
     ├ 후보가 2개 이상이면 AF_CHOOSE → 페이지 내 오버레이로 계정 선택 (**건너뛰지 않는다**)
     │    └ 오버레이에는 라벨 또는 **마스킹된 아이디**만 넣는다(페이지 JS 노출 최소화)
     │       키보드: Enter / 숫자키 / ↑↓ / ESC
     ├ decryptString(key, account.secret)        ← AES-256-GCM
     │    └ 실패 시 secretMatchesKey() 로 키 지문 비교 → "손상" vs "다른 마스터 비밀번호"(KEY_MISMATCH) 구분
     ├ AF_FILL → autofill.js
     │    ├ location.origin 재확인 (주입 후 이동 방어)
     │    ├ waitForEl(MutationObserver, 8s)      ← SPA/동적 폼 대기
     │    ├ 네이티브 setter + input/change 이벤트 ← React/Vue 제어 컴포넌트 대응
     │    └ autoSubmit 이면 버튼 활성화 대기(2s) 후 클릭
     ├ 성공 → vault.touchUnlock() (활동 기반 자동 잠금 연장) + 배지 ✓
     └ 실패 → 원인별 페이지 토스트 + 배지 !
```

사이드 패널에서 **▶ 실행 / 테스트** 를 누르면 같은 함수를 `{siteId, accountId, tabId}` 로 호출한다
(`runtime.sendMessage` → `LOGIN_RUN`). 잠금 해제 직후에는 `LOGIN_RETRY_PENDING` 으로 보류된 요청을 이어서 실행한다.

> **기본 계정(`defaultAccountId`)은 선택창을 건너뛰지 않는다.** 건너뛰면 2번째 이후 계정을 쓸 방법이 없어진다
> (첫 계정 추가 시 자동으로 기본값이 되므로 사실상 항상 그 상태가 된다). 맨 앞 정렬 + 포커스만 담당하고,
> `Enter` 한 번으로 실행되므로 체감 비용은 키 하나다.

## 페이지 내 단축키 (F2 / F4) — 왜 콘텐츠 스크립트인가

Chrome `commands` API 의 제약(공식 문서 확인):
- 단축키는 **`Ctrl` 또는 `Alt` 를 반드시 포함**해야 한다 (미디어 키만 예외)
- 지원 키 목록에 **`F1`~`F12` 가 없다**
- 매니페스트가 제안할 수 있는 단축키는 최대 4개이며, 사용자가 `chrome://extensions/shortcuts` 에서 바꿀 때도 같은 규칙이 적용된다

→ `F2`·`F4` 단독 키는 commands 로 **등록 자체가 불가능**하므로, 페이지에서 직접 받는다.

```
[서비스 워커 부팅 / 사이트·설정 변경 시]
  syncHotkeyRegistration()
   ├ loadSites() + getSettings()
   ├ hotkey.enabled 가 false → 등록 해제만 하고 종료
   ├ hotkeyAllSites !== false → ["http://*/*","https://*/*"]   (기본: 패널 토글을 어디서든)
   │               false        → toMatchPatterns(sites)        (등록 사이트만, 범위 최소화)
   ├ 패턴이 0개 → 등록하지 않음    ← 빈 matches 로는 registerContentScripts 호출 불가
   └ registerContentScripts([{ id:"ua-login-hotkey", js:["src/content/hotkey.js"],
                               runAt:"document_start", allFrames:false,
                               persistAcrossSessions:true, matches }])
        └ 포트 포함 패턴이 거부되면 포트를 뺀 패턴으로 재시도(포트 없는 패턴은 모든 포트에 일치)

[사용자가 페이지에서 F2 / F4]
  hotkey.js keydown(캡처 단계)
   ├ storage.sync 의 ua_login_settings 와 조합 비교 (정규화 문자열 1개, panelHotkey 우선)
   ├ needsTypingGuard(combo) && 입력창 포커스 → 무시 (F2/F4 같은 기능키는 통과)
   ├ preventDefault + stopPropagation, 연타 가드(로그인 1.2초 / 패널 0.35초)
   └ runtime.sendMessage({type:"LOGIN_HOTKEY" | "PANEL_TOGGLE"}) → 서비스 워커
        ├ LOGIN_HOTKEY  → sender.tab.id 로 runAutoLogin({tabId})  ← 활성 탭 추측 대신 보낸 탭
        └ PANEL_TOGGLE  → openPanelWindows 조회 후 sidePanel.open/close
```

### 패널 토글(F4)의 까다로운 제약

1. **사용자 제스처** — `chrome.sidePanel.open()` 은 사용자 동작에 대한 응답으로만 호출할 수 있다.
   콘텐츠 스크립트의 키 입력은 유효한 제스처이고 메시지에 함께 전달되지만,
   **수신 측이 `await` 를 만나는 순간 사라진다.** → 핸들러에서 `await` 없이 **동기 호출**한다.
2. **열림 여부를 묻는 API 가 없다** — 그런데 1 때문에 `storage` 조회(비동기)도 끼울 수 없다.
   → 패널이 열려 있는 동안 `runtime.connect({name:"ua-sidepanel:<windowId>"})` 포트를 유지하고,
   서비스 워커는 `openPanelWindows` **메모리 집합**으로 즉시 판단한다.
   포트가 연결돼 있으면 SW 가 살아 있으므로 집합을 신뢰할 수 있고, SW 가 죽었다면 집합이 비는데
   그때는 패널도 닫힌 상태라 결과가 맞다. 패널 쪽은 포트가 끊기면 재연결한다.
3. **`chrome.sidePanel.close()` 는 Chrome 141+** — 미지원 버전에서는 열기만 되고 안내 메시지를 띄운다.

- 등록 범위가 느슨해지는 부분(경로 접두어, 포트 생략)은 **`siteMatches()` 가 다시 엄격하게 검사**하므로
  자격증명 주입 조건은 전역 단축키 경로와 동일하다.
- 한계: 브라우저 UI(주소창 등)에 포커스가 있으면 동작하지 않는다 → 그 경우는 전역 단축키(`Ctrl+Shift+L`)를 쓴다.
- 콘텐츠 스크립트는 ES 모듈이 아니어서 `src/lib/hotkey.js` 를 import 할 수 없다.
  `comboFromEvent`/`isTypingTarget`/`needsTypingGuard` 세 함수를 복제했고,
  **복제본이 lib 와 갈라지면 `tools/test-hotkey.mjs` 가 실패**한다(파일에서 해당 구간을 꺼내 같은 입력으로 비교).

## 보안 모델 (자동 로그인)

| 대상 | 저장 위치 | 동기화 | 비고 |
|---|---|---|---|
| 사이트/계정/셀렉터 | `storage.sync` `ua_site_<id>` | ✅ | 사이트당 1항목(8KB 제한 회피 + 충돌 범위 축소) |
| 암호화된 비밀번호 | 위 항목 안의 `accounts[].secret` = `{iv, ct, kf}` | ✅ | AES-256-GCM, 레코드별 고유 IV. `kf`=키 지문(진단용) |
| salt / 반복 횟수 / 검증자 | `storage.sync` `ua_vault` | ✅ | salt는 비밀이 아님. 검증자 = 알려진 평문의 암호문 |
| 자동 잠금 시간 · 페이지 단축키 | `storage.sync` `ua_login_settings` | ✅ | 설정값만 (`{ autoLockMinutes, hotkey:{combo,enabled} }`) |
| **마스터 비밀번호** | 저장하지 않음 | ❌ | 분실 시 복구 불가 |
| **복호화 키(raw)** | `storage.session` `ua_unlock` | ❌ | 인메모리·디스크 미기록·콘텐츠 스크립트 접근 불가 |
| 중복 실행 락 / 보류 요청 | `storage.session` | ❌ | |

- MV3 서비스 워커는 유휴 시 종료되므로 전역 변수로 잠금 상태를 유지할 수 없다 → `storage.session` 사용.
  트레이드오프: 세션 동안 raw 키가 확장 프로세스 메모리에 있다. 대신 **디스크·동기화에는 남지 않는다.**
- 자동 잠금은 `alarms` 권한 없이 **접근 시점 지연 평가**로 처리한다(만료면 즉시 세션 삭제).
- 기존 텍스트 추출 데이터(`storage.local`: `current`/`presets`/`allowedPatterns`)와 **키 공간이 완전히 분리**되어 있다.

### 동기화 경합으로 금고를 잃는 경로 (막아 둠)

Chrome sync 는 키별로 따로 도착하며 **순서를 보장하지 않는다.** 그래서 이런 순서가 가능하다.

```
PC A: 금고 생성(salt_A) + 사이트/암호문 저장
PC B: 확장 설치 → ua_site_* 는 도착, ua_vault 는 아직 미도착
      → isInitialized() === false → "최초 설정" 화면 → 새 금고(salt_B) 생성
      → sync 병합(키 단위 last-write-wins) → ua_vault = salt_B
      → PC A 의 암호문은 salt_A 로 만든 키가 필요한데 그 키를 만들 수 없다 → 영구 손실
```

- 방지: `hasAnyLoginData()` (인덱스 또는 `ua_site_*` 존재)가 true 이고 금고가 없으면
  `initVault()` 가 `ERR_SYNC_PENDING` 으로 **거부**하고 "동기화 중" 안내를 띄운다.
- 진단: 그래도 섞인 상태가 생기면 암호문의 `kf`(키 지문)로 "다른 마스터 비밀번호로 암호화됨"을 구분해 알려준다.
- `salt` 는 비밀이 아니므로 동기화해도 된다. 같은 마스터 비밀번호 → 같은 키가 유도되는 근거가 이것이다.
- 틀린 마스터 비밀번호는 `verifier` 검증에서 거부되므로 **반쯤 열린 상태는 없다.**

## 셀렉터 전략 (`buildSelector`)
0. **문서 전체에서 유일한 앵커 우선** — `#id`, 다음으로 `tag[name=…]`·`data-testid`·`autocomplete`·`aria-label`·`placeholder`·`type`.
   하나라도 문서에서 유일하면 그것만 반환한다(짧고 위치에 독립적 → 로그인 입력창에 특히 유효).
1. 조상 중 `id`가 있으면 `#id`를 앵커로 사용하고 거기서 멈춤.
2. 그 외에는 각 단계에서 **안정 속성 → 안정 클래스 → 태그 → `:nth-of-type(n)`** 순으로 조각을 만들어 경로 생성.
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

### 자동 로그인 (storage.sync)

```js
ua_login_index    = { schemaVersion, siteIds: [id…], updatedAt }
ua_vault          = { schemaVersion, kdf:"PBKDF2-SHA256", iterations, salt, verifier:{iv,ct}, updatedAt }
ua_login_settings = {
  autoLockMinutes,                               // 기본 60 (60·240·480)
  hotkey:      { combo, enabled },               // 기본 { "F2", true } — 로그인/로그아웃
  panelHotkey: { combo, enabled },               // 기본 { "F4", true } — 패널 열기/닫기
  hotkeyAllSites                                 // 기본 true — 모든 http(s) 페이지에 리스너
}
ua_site_<id>      = {
  id, schemaVersion, name, url,
  origin,                 // "https://host[:port]" — 완전 일치 비교용
  path, matchPath,        // 경로 범위로 제한할지
  autoLogin, autoSubmit,  // 사용 여부 / 버튼 자동 클릭 여부
  autoLogout,             // 로그인 상태면 같은 단축키로 로그아웃
  sel: { user, pass, submit, logout },       // CSS Selector (logout = 로그인 상태 판별에도 사용)
  accounts: [{ id, label, username, secret:{iv,ct} }],
  defaultAccountId,       // 선택창에서 맨 앞 정렬 + 포커스 (건너뛰기 아님)
  rev, updatedAt          // 다른 PC의 변경 구분용
}
```
- 충돌 처리: sync 자체는 키 단위 last-write-wins. 편집 중에 `storage.onChanged`(sync)가 오면
  입력을 덮지 않고 "다른 기기에서 변경됨"만 알리고, 저장 시 내 내용이 최신이 된다.
- 스키마 버전(`schemaVersion`)을 항목마다 기록해 추후 마이그레이션 여지를 둔다.

## 조합 규칙
- `join`: `enabled`인 규칙 결과를 구분자로 연결.
- `template`: `{1}`,`{2}`… = 전체 규칙 순서 기준 1-based 결과 치환. 비활성 규칙은 빈 문자열.
