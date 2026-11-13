# OTP 인증기 — 설계 (v0.7.0, 2026-11-13)

폰의 Google OTP 를 꺼내 보지 않고 사이드 패널에서 TOTP 코드를 확인·복사하는 기능.
참고 프로젝트: [Authenticator-Extension/Authenticator](https://github.com/Authenticator-Extension/Authenticator) (코드는 가져오지 않고 기능 범위만 참고).

## 결정 사항 (사용자 합의)

| 항목 | 결정 |
|---|---|
| 메뉴 이름 | 새 메뉴 **「OTP 인증기」**, 기존 슬랙 DM 인증번호 메뉴는 **「유니클라우드 2차 인증」**으로 변경 |
| 범위 (MVP) | TOTP 표시·복사 / 화면 QR 스캔 / QR 이미지 / 직접 입력 / otpauth URI / **Google OTP 내보내기 가져오기** / 수정·삭제·검색·드래그 순서 |
| 마스터 비밀번호 | 자동 로그인과 **같은 비밀번호** |
| 자동 입력 | **이번에는 제외** (페이지의 OTP 칸에 넣는 기능 없음) |
| 제외 | 클라우드 백업(Dropbox 등), Steam·Blizzard, HOTP, 별도 비밀번호 |
| 보안 | A1~A7 전부 + B1~B4 적용, **B5(마스터 비밀번호 강도 경고)는 보류** |

## 보안 구조

| # | 내용 | 구현 위치 |
|---|---|---|
| A1 | **봉투 암호화**: 무작위 DEK(256bit)로 항목을 암호화하고, DEK 는 `PBKDF2(마스터 비밀번호, OTP 전용 salt, 60만회)` 로 만든 KEK 로 감싼다. 마스터 변경 시 DEK 만 다시 감쌈 | `lib/otp-store.js` `wrapDek`/`rewrap` |
| A2 | 발급자·계정·비밀키 **항목 전체**를 암호화 (저장소에는 id 와 암호문뿐) | `encryptEntry` |
| A3 | AES-GCM **AAD = 항목 id** → 다른 자리로 바꿔치기하면 복호화 실패 (`broken` 표시) | `aadEntry` |
| A4 | **복호화는 서비스 워커에서만**. 패널은 발급자·계정·코드·남은 시간만 받는다. 스캔·붙여넣기 결과도 비밀키 없이 미리보기만 받고, 비밀키는 `storage.session` 에 5분 대기 | `background/otp.js` |
| A5 | **비밀키 보기**는 잠금이 풀려 있어도 마스터 비밀번호를 다시 받는다. 30초 뒤 화면에서 지움 | `reveal` |
| A6 | 화면 캡처·이미지는 해석 후 바로 버리고(캔버스 지움), 비밀값을 로그에 남기지 않는다 | `offscreen.js` `decodeQr` |
| A7 | 백업은 **암호문 그대로**만. 평문 내보내기 기능 없음 | `lib/backup.js` |
| B1 | OTP 전용 **짧은 자동 잠금**(30분·1시간·4시간, 기본 30분). 예전 값은 바로 위 선택지로 올림. 복사·등록할 때만 연장(띄워 두기만 해서는 연장 안 함) | `startSession`/`touchSession` |
| B2 | **코드 가리기**(기본 켬) — 마우스를 올리거나 포커스했을 때만 숫자 표시 | CSS `.otp-list.masked` |
| B3 | 복사한 코드 **30초 뒤 클립보드 지우기**(기본 켬). 그 사이 다른 것을 복사했으면 그대로 둠 → `clipboardRead` 권한 추가 | `offscreen/offscreen.js` |
| B4 | OTP 는 **이 PC 에만**(`storage.local`) — 동기화하지 않음 | `otp-store.js` |

추가로:
- OTP 메시지는 **확장 페이지(사이드 패널)에서 온 것만** 처리한다(`isExtensionPage`). 웹페이지·콘텐츠 스크립트에서는 호출 불가.
- `storage.local` 은 이미 `TRUSTED_CONTEXTS` 로 제한돼 콘텐츠 스크립트가 읽지 못한다.
- 설정의 「지금 잠그기」와 백업 가져오기는 OTP 도 함께 잠근다.

### 마스터 비밀번호가 바뀌었을 때

KEK 는 자동 로그인 금고(`ua_vault`)의 salt 가 아니라 **OTP 전용 salt** 로 만든다. 그래서 다른 PC 에서 마스터를 바꿔
금고가 동기화로 바뀌어도, 이 PC 의 OTP 는 이전 비밀번호로 열 수 있다.

- 이 PC 에서 변경: `login.js` 가 변경 직후 `OTP_REWRAP(old, new)` → DEK 를 새 비밀번호로 다시 감쌈
- 다른 PC 에서 변경: 감쌀 때 기록한 금고 salt(`vaultSalt`)와 지금 금고 salt 가 다르면 → 잠금 화면이
  **「이전 마스터 비밀번호 + 현재 마스터 비밀번호」**를 받아 옮김(`OTP_MIGRATE_MASTER`)
- 현재 마스터가 아닌 비밀번호로는 열리더라도 바로 쓰지 않고 옮기기를 안내한다(같은 비밀번호 원칙 유지)

## 저장 형식

| 위치 | 키 | 내용 |
|---|---|---|
| local | `ua_otp_key` | `{ v, kdf, iterations, salt, iv, ct, vaultSalt, updatedAt }` 감싼 DEK |
| local | `ua_otp_index` | `{ ids: [] }` 표시 순서 |
| local | `ua_otp_e_<id>` | `{ v, iv, ct }` — 평문 `{ issuer, account, secret, algorithm, digits, period, createdAt }` |
| sync | `ua_otp_settings` | `{ autoLockMinutes, maskCodes, clearClipboard }` (비밀 아님) |
| session | `ua_otp_session` | `{ dekB64, expiresAt }` 잠금 해제 세션 (메모리 전용) |
| session | `ua_otp_pending` | 스캔·붙여넣기로 읽고 아직 확인 전인 항목 (5분) |

백업: `ua_otp_` 로 시작하는 local 키를 포함. 백업에 OTP 가 있으면 이 PC 의 OTP 를 통째로 바꾸고,
없으면(예전 백업) 이 PC 의 OTP 는 그대로 둔다.

## 메시지 (패널 → 서비스 워커)

`OTP_STATUS` · `OTP_UNLOCK{password}` · `OTP_MIGRATE_MASTER{oldPassword,password}` · `OTP_REWRAP{oldPassword,newPassword}` ·
`OTP_LOCK` · `OTP_LIST` · `OTP_COPY{id}` · `OTP_ADD{entry}` · `OTP_PARSE_TEXT{text}` · `OTP_SCAN_TAB{windowId}` ·
`OTP_SCAN_IMAGE{dataUrl}` · `OTP_IMPORT_CONFIRM{tmpIds}` · `OTP_IMPORT_CANCEL` · `OTP_UPDATE{id,patch}` · `OTP_DELETE{id}` ·
`OTP_REORDER{ids}` · `OTP_REVEAL{id,password}`

## 형식 지원

- TOTP: SHA1 / SHA256 / SHA512, 6~8자리, 주기 10~300초 (RFC 6238 부록 B 벡터로 검증)
- `otpauth://totp/…` (Google Key URI 형식). HOTP 는 거부
- `otpauth-migration://offline?data=…` (Google OTP 내보내기 protobuf). HOTP·MD5 항목은 건너뛰고 이유 표시. 여러 장 QR 은 `batch` 표시
- QR 해석: jsQR 1.4.0 (`src/vendor/jsqr.js`, Apache-2.0). Windows 크롬에는 `BarcodeDetector` 가 없어서 포함.
  **오프스크린 문서가 처음 스캔할 때만** 불러온다(서비스 워커에 두면 워커가 깰 때마다 257KB 를 읽어 시작 시간이 2배가 됐다)

## 확인 방법

- 단위: `node tools/test-totp.mjs`(58), `node tools/test-otp-store.mjs`(67), `node tools/test-backup.mjs`(16)
- 실제 크로미움(Playwright, 2026-11-13): 시작·잠금, 직접 입력 코드 일치, 가리기, 붙여넣기 미리보기(중복 해제),
  **화면 QR 스캔**, **Google 내보내기 QR 이미지**, 클릭 복사, **30초 뒤 클립보드 비움 / 다른 것 복사 시 유지**, 비밀키 보기, 잠금 시 목록 제거 — 모두 통과.
  (패널을 탭으로 열면 `isExtensionPage` 가 거절하므로 테스트 사본에서만 그 조건을 풀었다)

## 나중에 (2차)

- 사이트 연결 + 페이지 OTP 칸 자동 입력 / 현재 사이트 코드 복사 단축키
- 비밀키 QR 로 내보내기(다른 앱으로 옮기기), Windows Hello(WebAuthn PRF) 잠금 해제
- B5 마스터 비밀번호 강도 경고 (보류)
