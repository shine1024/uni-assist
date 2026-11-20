// 데이터 지우기 범위 테스트 (node tools/test-wipe.mjs)
import assert from "node:assert/strict";
import { isResetConfirmed, wipeStorage, WIPE_ALL, WIPE_DEVICE } from "../src/lib/wipe.js";

function area(init) {
  let data = { ...init };
  return { clear: async () => { data = {}; }, dump: () => data };
}
function areas() {
  return {
    sync: area({ ua_vault: 1, ua_site_a: 2 }),
    local: area({ ua_otp_index: 1, ua_slack: 2, siteRules: 3 }),
    session: area({ ua_unlock: 1 }),
  };
}

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };

await t("device: local·session 만 지우고 sync 는 둔다", async () => {
  const a = areas();
  await wipeStorage(a, WIPE_DEVICE);
  assert.deepEqual(a.local.dump(), {});
  assert.deepEqual(a.session.dump(), {});
  assert.deepEqual(a.sync.dump(), { ua_vault: 1, ua_site_a: 2 });
});

await t("all: sync 까지 지운다", async () => {
  const a = areas();
  await wipeStorage(a, WIPE_ALL);
  assert.deepEqual(a.local.dump(), {});
  assert.deepEqual(a.session.dump(), {});
  assert.deepEqual(a.sync.dump(), {});
});

await t("알 수 없는 범위는 아무것도 지우지 않고 거부", async () => {
  const a = areas();
  await assert.rejects(() => wipeStorage(a, "sync"));
  assert.equal(Object.keys(a.local.dump()).length, 3);
});

await t("확인 문구", async () => {
  assert.equal(isResetConfirmed("초기화"), true);
  assert.equal(isResetConfirmed("  초기화 "), true);
  assert.equal(isResetConfirmed("초기"), false);
  assert.equal(isResetConfirmed(null), false);
});

console.log(`\n${n}개 통과`);
