// 이 PC 에만 적용되는 설정 (storage.local — 동기화·백업하지 않는다)
//
// 「잠그지 않음 (이 PC 기억)」: 잠금 해제 키를 storage.session(메모리, 브라우저를 닫으면 사라짐) 대신
// storage.local(이 PC 디스크)에도 둬서 브라우저를 다시 켜도 마스터 비밀번호를 묻지 않는다.
//  · PC 마다 따로 정한다 — 동기화되는 설정(ua_login_settings)에 두면 모든 PC 가 같이 풀려 버린다
//  · 기억한 키는 동기화되지 않으며(local), 백업 파일에도 들어가지 않는다(backup.js 는 ua_device_ 를 고르지 않음)
//  · storage.local 은 서비스 워커가 TRUSTED_CONTEXTS 로 묶어 두어 콘텐츠 스크립트가 읽을 수 없다
//  · 「지금 잠그기」·옵션 끄기·마스터 비밀번호 변경 시 지운다
//  트레이드오프: 이 PC 의 크롬 프로필에 접근할 수 있는 사람은 잠금 없이 쓸 수 있다(크롬 저장 비밀번호와 비슷한 수준).

export const L_DEVICE_PREFS = "ua_device_prefs"; // { vaultNeverLock, otpNeverLock }
export const L_VAULT_KEY = "ua_device_vault_key"; // { keyB64, verifier } — verifier 가 금고와 다르면(마스터 변경) 버린다
export const L_OTP_DEK = "ua_device_otp_dek"; // { dekB64, ct } — ct 가 OTP 키 레코드와 다르면 버린다

export const NEVER_LOCK = "never"; // 자동 잠금 선택지 값

export async function getDevicePrefs() {
  const { [L_DEVICE_PREFS]: p } = await chrome.storage.local.get(L_DEVICE_PREFS);
  return { vaultNeverLock: !!(p && p.vaultNeverLock), otpNeverLock: !!(p && p.otpNeverLock) };
}

export async function setDevicePrefs(patch) {
  const cur = await getDevicePrefs();
  await chrome.storage.local.set({ [L_DEVICE_PREFS]: { ...cur, ...patch } });
}
