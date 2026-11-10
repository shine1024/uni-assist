// OS 키체인 접근 (macOS 키체인 / Windows 자격 증명 관리자)
import { Entry } from "@napi-rs/keyring";
import { Pop3Error } from "./pop3.js";

export const SERVICE = "unipost-approval-otp";
export const ACCOUNTS = { mail: "메일 비밀번호" };

const entry = (account) => new Entry(SERVICE, account);

/** @param {"mail"} account */
export function getSecret(account) {
  let value = null;
  try {
    value = entry(account).getPassword();
  } catch {
    value = null;
  }
  if (!value) {
    throw new Pop3Error("CREDENTIAL_MISSING", `${ACCOUNTS[account]}가 등록되어 있지 않아요. 설치 스크립트를 실행하세요`);
  }
  return value;
}

export function hasSecret(account) {
  try {
    return !!entry(account).getPassword();
  } catch {
    return false;
  }
}

export function setSecret(account, value) {
  entry(account).setPassword(value);
}

export function deleteSecret(account) {
  try {
    entry(account).deletePassword();
  } catch {
    /* 없으면 지울 것도 없다 */
  }
}
