// 백업 파일 만들기 / 읽기 (크롬 API 비의존 → 단위 테스트 가능)
//
// 확장 ID 가 바뀌면(예: manifest `key` 로 ID 고정) chrome.storage 가 새로 시작되므로,
// 옮겨 갈 데이터를 파일로 꺼냈다가 다시 넣는 용도다.
//  - sync : 자동 로그인 데이터(`ua_` 로 시작하는 키 전부). 비밀번호는 원래 저장된 암호문 그대로라
//           파일만으로는 풀 수 없고, 같은 마스터 비밀번호가 있어야 한다.
//  - local: 텍스트 추출 데이터(current / presets / allowedPatterns)
import { K_VAULT, SITE_PREFIX } from "./login-store.js";

export const BACKUP_FORMAT = "uni-assist-backup";
export const BACKUP_VERSION = 1;
export const SYNC_PREFIX = "ua_";
export const LOCAL_KEYS = ["current", "presets", "allowedPatterns"];

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

function pickSync(sync) {
  const out = {};
  for (const [k, v] of Object.entries(sync || {})) if (k.startsWith(SYNC_PREFIX)) out[k] = v;
  return out;
}

function pickLocal(local) {
  const out = {};
  for (const k of LOCAL_KEYS) if (local && local[k] !== undefined) out[k] = local[k];
  return out;
}

/** storage 내용 → 백업 객체 */
export function buildBackup({ sync, local }, now = new Date()) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    sync: pickSync(sync),
    local: pickLocal(local),
  };
}

export function backupFileName(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `uni-assist-backup-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}.json`;
}

/** 백업 요약 (가져오기 전 확인 문구용) */
export function summarizeBackup({ sync, local }) {
  const sites = Object.keys(sync).filter((k) => k.startsWith(SITE_PREFIX)).length;
  const rules = isPlainObject(local.current) && Array.isArray(local.current.rules) ? local.current.rules.length : 0;
  const presets = Array.isArray(local.presets) ? local.presets.length : 0;
  return { sites, rules, presets, hasVault: !!sync[K_VAULT] };
}

/**
 * 파일 내용 → { sync, local }. 형식이 다르면 사용자에게 보여 줄 메시지로 Error 를 던진다.
 * 사이트가 있는데 금고 정보(salt/검증자)가 없으면 저장된 비밀번호를 영영 풀 수 없으므로 거부한다.
 */
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("백업 파일을 읽지 못했어요 (JSON 형식이 아니에요)");
  }
  if (!isPlainObject(data) || data.format !== BACKUP_FORMAT) {
    throw new Error("Uni-Assist 백업 파일이 아니에요");
  }
  if (data.version !== BACKUP_VERSION) {
    throw new Error(`지원하지 않는 백업 버전이에요 (${data.version})`);
  }
  if (!isPlainObject(data.sync) || !isPlainObject(data.local)) {
    throw new Error("백업 파일 내용이 올바르지 않아요");
  }
  const sync = pickSync(data.sync);
  const local = pickLocal(data.local);
  const hasSites = Object.keys(sync).some((k) => k.startsWith(SITE_PREFIX));
  if (hasSites && !sync[K_VAULT]) {
    throw new Error("백업에 금고 정보가 없어 저장된 비밀번호를 복원할 수 없어요");
  }
  return { sync, local };
}
