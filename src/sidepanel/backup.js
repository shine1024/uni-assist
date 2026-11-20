// 사이드 패널: 설정 → 백업 (내보내기 / 가져오기)
import { K_SITE_RULES } from "../lib/site-rules.js";
import { backupFileName, buildBackup, isBackupLocalKey, parseBackup, summarizeBackup, SYNC_PREFIX } from "../lib/backup.js";
import * as vault from "../lib/vault.js";
import { OTP_LOCAL_PREFIX } from "../lib/otp-store.js";
import { isResetConfirmed, RESET_CONFIRM_WORD, wipeStorage, WIPE_ALL, WIPE_DEVICE } from "../lib/wipe.js";

const $ = (s) => document.querySelector(s);
let toast = () => {};

async function exportBackup() {
  const [sync, local] = await Promise.all([chrome.storage.sync.get(null), chrome.storage.local.get(null)]);
  const now = new Date();
  const backup = buildBackup({ sync, local }, now);
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = backupFileName(now);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const s = summarizeBackup(backup);
  toast(`내보냈어요 — 사이트 ${s.sites}개, OTP ${s.otps}개, 추출 규칙 ${s.rules}개, 프리셋 ${s.presets}개`);
}

async function importBackup(file) {
  let data;
  try {
    data = parseBackup(await file.text());
  } catch (e) {
    toast(e.message);
    return;
  }
  const s = summarizeBackup(data);
  const ok = confirm(
    `백업을 가져올까요?\n\n사이트 ${s.sites}개 · OTP ${s.otps}개 · 추출 규칙 ${s.rules}개 · 프리셋 ${s.presets}개\n\n` +
      "지금 이 PC의 자동 로그인 데이터와 텍스트 추출 설정은 백업 내용으로 바뀝니다.\n" +
      (s.hasOtp
        ? "OTP 인증기도 백업 내용으로 바뀝니다.\n"
        : "백업에 OTP 인증기가 없어서 이 PC의 OTP 는 그대로 둡니다.\n") +
      "가져온 뒤에는 백업할 때의 마스터 비밀번호로 잠금을 해제하세요."
  );
  if (!ok) return;

  // 금고(salt)가 다른 데이터와 섞이면 비밀번호를 풀 수 없으므로 자동 로그인 데이터는 통째로 바꾼다.
  const current = await chrome.storage.sync.get(null);
  const stale = Object.keys(current).filter((k) => k.startsWith(SYNC_PREFIX) && !(k in data.sync));
  if (stale.length) await chrome.storage.sync.remove(stale);
  await chrome.storage.sync.set(data.sync); // 금고 정보와 사이트를 한 번에 쓴다
  // 예전 형식 백업(규칙 묶음 하나)이면 사이트별 저장을 비워, 패널이 열릴 때 다시 옮기게 한다
  if (!(K_SITE_RULES in data.local) && data.local.current) await chrome.storage.local.remove(K_SITE_RULES);
  // OTP 는 키와 항목이 한 묶음이다. 백업에 OTP 가 있으면 이 PC 의 OTP 를 통째로 바꾸고
  // (다른 키로 암호화된 항목이 섞이지 않게), 없으면(예전 백업) 이 PC 의 OTP 를 그대로 둔다.
  if (s.hasOtp) {
    const curLocal = await chrome.storage.local.get(null);
    const staleLocal = Object.keys(curLocal).filter(
      (k) => k.startsWith(OTP_LOCAL_PREFIX) && isBackupLocalKey(k) && !(k in data.local)
    );
    if (staleLocal.length) await chrome.storage.local.remove(staleLocal);
  }
  if (Object.keys(data.local).length) await chrome.storage.local.set(data.local);
  await vault.lock(); // 이전 금고의 해제 세션은 새 데이터에 맞지 않는다
  await chrome.runtime.sendMessage({ type: "OTP_LOCK" }).catch(() => {});

  toast("가져왔어요 — 패널을 다시 불러옵니다");
  setTimeout(() => location.reload(), 900);
}

// ---- 데이터 지우기 ----------------------------------------------------------

async function wipe(scope) {
  const all = scope === WIPE_ALL;
  const what = all
    ? "이 PC 데이터와 동기화 데이터(자동 로그인 사이트·계정·금고, 설정, 슬랙 앱 정보)를 모두 지웁니다.\n\n" +
      "⚠ 크롬 동기화가 켜져 있으면 다른 PC 와 구글 서버에서도 지워집니다.\n" +
      "이 PC 에서만 지우려면 취소하고 먼저 크롬에서 로그아웃(동기화 끄기)하세요."
    : "OTP 인증기, 슬랙·Claude 연결, 「잠그지 않음」 기억, 텍스트 추출 규칙·프리셋을 이 PC 에서 지웁니다.\n" +
      "동기화되는 자동 로그인 사이트·계정은 암호화된 채로 남습니다.";
  if (!confirm(`${all ? "전체 초기화" : "이 PC 데이터 지우기"}\n\n${what}\n\n계속할까요?`)) return;

  if (confirm("지우기 전에 백업 파일을 내보낼까요?\n\n확인 = 내보낸 뒤 계속 / 취소 = 백업 없이 계속")) {
    await exportBackup();
  }
  if (all) {
    const typed = prompt(`정말 전체 초기화할까요? 확인하려면 「${RESET_CONFIRM_WORD}」를 입력하세요.`);
    if (!isResetConfirmed(typed)) {
      if (typed !== null) toast("입력이 달라서 취소했어요");
      return;
    }
  }

  // 슬랙 토큰은 지우기 전에 서버에서 폐기하고, 해제 세션을 먼저 닫는다
  await chrome.runtime.sendMessage({ type: "APPROVAL_DISCONNECT" }).catch(() => null);
  await chrome.runtime.sendMessage({ type: "OTP_LOCK" }).catch(() => {});
  await vault.lock().catch(() => {});
  await wipeStorage({ sync: chrome.storage.sync, local: chrome.storage.local, session: chrome.storage.session }, scope);

  toast(all ? "전체 초기화했어요 — 패널을 다시 불러옵니다" : "이 PC 데이터를 지웠어요 — 패널을 다시 불러옵니다");
  setTimeout(() => location.reload(), 900);
}

export function initBackupUI(deps) {
  toast = deps.toast;
  const input = $("#backup-file");
  $("#btn-backup-export").addEventListener("click", () =>
    exportBackup().catch((e) => toast("내보내기 실패: " + e.message))
  );
  $("#btn-backup-import").addEventListener("click", () => input.click());
  $("#btn-wipe-device").addEventListener("click", () =>
    wipe(WIPE_DEVICE).catch((e) => toast("지우기 실패: " + e.message))
  );
  $("#btn-wipe-all").addEventListener("click", () =>
    wipe(WIPE_ALL).catch((e) => toast("초기화 실패: " + e.message))
  );
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    input.value = ""; // 같은 파일을 다시 골라도 change 가 오도록
    if (file) importBackup(file).catch((e) => toast("가져오기 실패: " + e.message));
  });
}
