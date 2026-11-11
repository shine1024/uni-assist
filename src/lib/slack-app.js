// 슬랙 앱 정보(Client ID/Secret) 저장 — 패널에서 한 번 입력하면 chrome.storage.sync 로 같은 구글 계정의 다른 PC 에도 전달된다.
//
// 저장소가 공개라 Secret 을 코드에 넣을 수 없어 사용자가 입력한다. 키에 `ua_` 접두어를 붙이지 않아 백업 파일에는 들어가지 않는다.
// 사용자 토큰(xoxp-)은 여기 두지 않는다 — 토큰은 PC 별 storage.local (background/approval.js 의 K_SLACK).
// 확장 폴더에 slack-config.json 이 있으면(예전 방식) 한 번 읽어 여기로 옮긴다.
import { validateSlackConfig } from "./slack-otp.js";

export const K_SLACK_APP = "slack_app"; // { clientId, clientSecret }

async function fromFile() {
  try {
    return await (await fetch(chrome.runtime.getURL("slack-config.json"))).json();
  } catch {
    return null;
  }
}

/** 저장된 앱 정보. 없으면 SLACK_CONFIG_MISSING */
export async function loadSlackApp() {
  const { [K_SLACK_APP]: saved } = await chrome.storage.sync.get(K_SLACK_APP);
  try {
    return validateSlackConfig(saved);
  } catch {
    const cfg = validateSlackConfig(await fromFile()); // 파일도 없으면 여기서 던진다
    await chrome.storage.sync.set({ [K_SLACK_APP]: cfg });
    return cfg;
  }
}

export async function saveSlackApp(input) {
  const cfg = validateSlackConfig(input);
  await chrome.storage.sync.set({ [K_SLACK_APP]: cfg });
  return cfg;
}
