// 사이드 패널: 설정 → 백업 (내보내기 / 가져오기)
import { K_SITE_RULES } from "../lib/site-rules.js";
import { backupFileName, buildBackup, parseBackup, summarizeBackup, SYNC_PREFIX } from "../lib/backup.js";
import * as vault from "../lib/vault.js";

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
  toast(`내보냈어요 — 사이트 ${s.sites}개, 추출 규칙 ${s.rules}개, 프리셋 ${s.presets}개`);
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
    `백업을 가져올까요?\n\n사이트 ${s.sites}개 · 추출 규칙 ${s.rules}개 · 프리셋 ${s.presets}개\n\n` +
      "지금 이 PC의 자동 로그인 데이터와 텍스트 추출 설정은 백업 내용으로 바뀝니다.\n" +
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
  if (Object.keys(data.local).length) await chrome.storage.local.set(data.local);
  await vault.lock(); // 이전 금고의 해제 세션은 새 데이터에 맞지 않는다

  toast("가져왔어요 — 패널을 다시 불러옵니다");
  setTimeout(() => location.reload(), 900);
}

export function initBackupUI(deps) {
  toast = deps.toast;
  const input = $("#backup-file");
  $("#btn-backup-export").addEventListener("click", () =>
    exportBackup().catch((e) => toast("내보내기 실패: " + e.message))
  );
  $("#btn-backup-import").addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    input.value = ""; // 같은 파일을 다시 골라도 change 가 오도록
    if (file) importBackup(file).catch((e) => toast("가져오기 실패: " + e.message));
  });
}
