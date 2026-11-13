// 사이드 패널 — 자동 로그인 화면 컨트롤러 (텍스트 추출과 독립된 모듈)
//
// 역할: 잠금/해제 UI, 사이트·계정 CRUD, 셀렉터 선택(picker.js 재사용), 보안·동기화 설정.
// 비밀번호 평문은 **저장 직전까지만** 메모리에 두고, 저장/화면 이동 시 즉시 폐기한다.

import { icon } from "./icons.js";
import { encryptSecret } from "../lib/crypto.js";
import {
  DEFAULT_COPY_COMBO,
  DEFAULT_PANEL_COMBO,
  comboFromEvent,
  displayCombo,
  hotkeyConflict,
  needsTypingGuard,
  normalizeHotkey,
} from "../lib/hotkey.js";
import {
  describeSiteUrl,
  findMatchingSites,
  findOriginMatchingSites,
  isValidSelector,
  toMatchPatterns,
} from "../lib/login-match.js";
import * as store from "../lib/login-store.js";
import * as vault from "../lib/vault.js";
import { ensurePicker, getActiveTab, injectable } from "../lib/tabs.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// 로그인용 3개 + 로그아웃 1개. logout 은 "로그인 상태 판별"에도 쓰인다(있으면 로그인된 것으로 본다).
const FIELDS = [
  { key: "user", label: "아이디", required: true },
  { key: "pass", label: "비밀번호", required: true },
  { key: "submit", label: "로그인 버튼" },
  { key: "logout", label: "로그아웃", hint: "로그인 상태에서만 존재하는 요소" },
];
const LOGIN_FIELDS = FIELDS.filter((f) => f.key !== "logout");

// ---- 모듈 상태 ------------------------------------------------------------
let sites = [];
let editing = null; // 편집 중인 사이트(사본). 저장 전까지 스토리지에 쓰지 않는다.
let pendingSecrets = {}; // accountId → 평문 비밀번호 (저장 시 암호화 후 즉시 폐기)
let selState = {}; // 셀렉터 확인 결과 표시용
let pickQueue = []; // "순서대로 선택" 대기열
let searchText = "";
let currentView = "extract";
let tick = null;
let capturing = null; // 키 지정 대기 중인 단축키 종류 ("auth" | "panel" | null)

let toast = () => {};
let showView = () => {};

// 평문 비밀번호 폐기
function wipeSecrets() {
  for (const k of Object.keys(pendingSecrets)) pendingSecrets[k] = null;
  pendingSecrets = {};
}

// ---- 초기화 / 뷰 전환 -----------------------------------------------------
export async function initLoginUI(deps) {
  toast = deps.toast;
  showView = deps.showView;
  bindStaticEvents();
  await refreshAll();
}

export function onViewShown(name) {
  currentView = name;
  clearInterval(tick);
  if (name === "login" || name === "settings") {
    refreshAll();
    tick = setInterval(refreshBadges, 20000); // 남은 잠금 시간 표시 갱신
  } else {
    // 다른 화면으로 나가면 입력 중인 평문 비밀번호를 들고 있지 않는다
    wipeSecrets();
  }
}

async function refreshAll() {
  const st = await refreshLockUI();
  if (st.initialized && st.unlocked) {
    sites = await store.loadSites().catch((e) => {
      toast("사이트 목록을 읽지 못했어요: " + e.message);
      return [];
    });
    await renderSiteList();
    if (editing) renderDetail();
  }
  await renderSettings(st);
}

// ---- 잠금 화면 ------------------------------------------------------------
async function refreshLockUI() {
  const st = await vault.status();
  const locked = !st.initialized || !st.unlocked;

  $("#lock-screen").classList.toggle("hidden", !locked);
  if (locked) {
    $("#site-detail").classList.add("hidden");
    editing = null;
    wipeSecrets();
  }
  // 상세 편집 중이면 목록을 다시 띄우지 않는다(둘이 겹쳐 보이던 문제)
  $("#login-main").classList.toggle("hidden", locked || !!editing);

  if (!st.initialized) {
    $("#lock-title").textContent = "마스터 비밀번호 설정";
    $("#lock-hint").innerHTML =
      "저장할 비밀번호를 암호화할 마스터 비밀번호를 정하세요. (AES-256-GCM, PBKDF2-SHA256)<br />" +
      "<b>다른 PC에서 이미 설정했다면 새로 만들지 말고 그 비밀번호를 입력하세요.</b> " +
      "동기화가 아직 도착하지 않았다면 잠시 뒤 다시 열어 보세요.";
    $("#master-pw").placeholder = "새 마스터 비밀번호 (8자 이상)";
    $("#master-pw2").classList.remove("hidden");
    $("#btn-unlock").textContent = "설정하고 시작";
  } else if (locked) {
    $("#lock-title").textContent = "잠금 해제";
    $("#lock-hint").textContent = "자동 로그인을 쓰려면 마스터 비밀번호를 입력하세요.";
    $("#master-pw").placeholder = "마스터 비밀번호";
    $("#master-pw2").classList.add("hidden");
    $("#btn-unlock").textContent = "잠금 해제";
  }
  return st;
}

function lockError(msg) {
  const el = $("#lock-error");
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
}

async function doUnlock() {
  const pw = $("#master-pw").value;
  const pw2 = $("#master-pw2").value;
  lockError("");
  const st = await vault.status();
  try {
    if (!st.initialized) {
      if (pw.length < 8) return lockError("마스터 비밀번호는 8자 이상이어야 합니다");
      if (pw !== pw2) return lockError("두 비밀번호가 일치하지 않습니다");
      await vault.initVault(pw);
      toast("마스터 비밀번호 설정 완료");
    } else {
      if (!pw) return lockError("마스터 비밀번호를 입력하세요");
      if (!(await vault.unlock(pw))) return lockError("마스터 비밀번호가 일치하지 않습니다");
      toast("잠금 해제");
    }
  } catch (e) {
    if (e.code === vault.ERR_SYNC_PENDING) {
      $("#master-pw").value = "";
      $("#master-pw2").value = "";
      await refreshAll();
      return lockError(e.message);
    }
    return lockError(e.message);
  } finally {
    $("#master-pw").value = "";
    $("#master-pw2").value = "";
  }

  await refreshAll();

  // 단축키로 시도했다가 잠금 때문에 보류된 자동 로그인을 이어서 실행
  try {
    const r = await chrome.runtime.sendMessage({ type: "LOGIN_RETRY_PENDING" });
    if (r && r.ok) toast("보류된 자동 로그인을 실행했어요");
    else if (r && r.message && r.code !== "NO_PENDING") toast(r.message);
  } catch (_) {
    /* 보류 요청 없음 */
  }
}

// ---- 사이트 목록 ----------------------------------------------------------
async function renderSiteList() {
  const tab = await getActiveTab().catch(() => null);
  const url = tab && tab.url ? tab.url : "";
  const matchIds = new Set(findMatchingSites(url, sites).map((s) => s.id));

  const q = searchText.trim().toLowerCase();
  const list = q
    ? sites.filter(
        (s) =>
          (s.name || "").toLowerCase().includes(q) ||
          (s.origin || "").toLowerCase().includes(q) ||
          (s.path || "").toLowerCase().includes(q)
      )
    : sites;

  $("#site-list").innerHTML = list.map((s) => siteRowHTML(s, matchIds.has(s.id))).join("");
  $("#site-empty").classList.toggle("hidden", sites.length > 0);

  const box = $("#current-match");
  if (!url || !/^https?:/.test(url)) {
    box.classList.add("hidden");
  } else {
    box.classList.remove("hidden");
    const n = matchIds.size;
    const originOnly = findOriginMatchingSites(url, sites).filter((s) => !matchIds.has(s.id));
    if (n) {
      box.innerHTML = `현재 탭에 등록된 사이트 <b>${n}개</b> — 단축키로 로그인/로그아웃할 수 있어요.`;
    } else if (originOnly.length) {
      // origin 은 맞지만 '경로까지 일치'에 걸려 로그인 대상에서 빠진 상태
      const s0 = originOnly[0];
      box.innerHTML = `
        <b>${esc(s0.name || s0.origin)}</b> 와 도메인은 같지만 경로가 달라요
        (등록 경로 <code>${esc(s0.path)}</code>).
        로그아웃은 동작하지만 <b>로그인은 그 경로에서만</b> 됩니다 —
        수정에서 <b>경로까지 일치</b>를 끄면 도메인 전체에서 동작합니다.`;
    } else {
      box.innerHTML = `현재 탭(<code>${esc(originOf(url))}</code>)은 등록되지 않았어요.
         <button class="btn btn-sm" id="btn-add-current">이 사이트 추가</button>`;
    }
  }
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (_) {
    return url;
  }
}

function siteRowHTML(s, isCurrent) {
  const accounts = s.accounts || [];
  const withPw = accounts.filter((a) => a.secret).length;
  return `
  <div class="site-item ${isCurrent ? "current" : ""}" data-site-id="${s.id}">
    <div class="site-main">
      <div class="site-name">
        ${esc(s.name || originOf(s.origin))}
        ${isCurrent ? '<span class="tag tag-ok">현재 탭</span>' : ""}
        ${s.autoLogin === false ? '<span class="tag tag-off">꺼짐</span>' : ""}
      </div>
      <div class="site-url">${esc(s.origin + (s.matchPath ? s.path : ""))}</div>
      <div class="site-meta muted">계정 ${accounts.length}개 · 비밀번호 저장 ${withPw}개${
        s.sel && s.sel.logout && s.autoLogout !== false ? " · 로그아웃 사용" : ""
      }</div>
    </div>
    <div class="site-side">
      <button class="btn btn-sm btn-icon" data-action="run" title="지금 실행 (로그인 상태면 로그아웃)">${icon("play")}</button>
      <button class="btn btn-sm" data-action="edit">수정</button>
      <button class="btn btn-sm btn-icon btn-danger" data-action="del" title="사이트 삭제">${icon("trash")}</button>
    </div>
  </div>`;
}

// ---- 사이트 상세 ----------------------------------------------------------
function openDetail(site) {
  editing = JSON.parse(JSON.stringify(site));
  if (!editing.sel) editing.sel = { user: "", pass: "", submit: "" };
  if (!Array.isArray(editing.accounts)) editing.accounts = [];
  selState = {};
  wipeSecrets();
  $("#login-main").classList.add("hidden");
  $("#site-detail").classList.remove("hidden");
  renderDetail();
}

function closeDetail() {
  editing = null;
  wipeSecrets();
  $("#site-detail").classList.add("hidden");
  $("#login-main").classList.remove("hidden");
}

function renderDetail() {
  const s = editing;
  if (!s) return;
  const d = describeSiteUrl(s.url);
  const urlInfo = d
    ? `origin <code>${esc(d.origin)}</code> · 경로 <code>${esc(d.path)}</code>`
    : '<span class="err-text">http(s) 주소를 입력하세요</span>';

  const selRows = LOGIN_FIELDS.map(selRowHTML).join("");

  const accRows = s.accounts.length
    ? s.accounts.map((a, i) => accountHTML(a, i, s.defaultAccountId)).join("")
    : '<p class="muted">등록된 계정이 없습니다. <b>+ 계정</b> 을 눌러 추가하세요.</p>';

  $("#site-detail").innerHTML = `
  <section class="card">
    <div class="card-head">
      <h2>${s.updatedAt ? "사이트 수정" : "사이트 추가"}</h2>
      <button class="btn btn-ghost btn-sm" data-action="close">${icon("back")}목록</button>
    </div>
    <div class="field-col">
      <label class="muted">사이트명</label>
      <input data-f="name" placeholder="예) 사내 Redmine" value="${esc(s.name)}" />
      <label class="muted">로그인 페이지 URL <span class="muted">(프로토콜·도메인·포트·경로)</span></label>
      <input data-f="url" spellcheck="false" placeholder="https://example.com:8443/login" value="${esc(s.url)}" />
      <p class="muted">${urlInfo}</p>
      <label class="chk"><input type="checkbox" data-f="matchPath" ${s.matchPath ? "checked" : ""} />
        경로까지 일치할 때만 <b>로그인</b> <span class="muted">(끄면 도메인 전체 — 권장)</span></label>
      ${
        s.matchPath
          ? `<p class="muted">${icon("alert", "ic-inline")}로그인은 <code>${esc(describeSiteUrl(s.url) ? describeSiteUrl(s.url).path : s.path)}</code>
             및 그 하위 경로에서만 동작합니다. 로그인 페이지 경로(<code>/login</code> 등)로 등록했다면
             로그인 후 다른 경로로 이동했을 때 동작하지 않으니, 끄거나 URL을 앱 루트로 고치세요.
             <b>로그아웃은 경로와 무관하게</b> 도메인이 같으면 동작합니다.</p>`
          : ""
      }
      <label class="chk"><input type="checkbox" data-f="autoLogin" ${s.autoLogin !== false ? "checked" : ""} />
        자동 로그인 사용</label>
      <label class="chk"><input type="checkbox" data-f="autoSubmit" ${s.autoSubmit !== false ? "checked" : ""} />
        로그인 버튼 자동 클릭</label>
    </div>
  </section>

  <section class="card">
    <div class="card-head">
      <h2>입력 요소 (CSS Selector)</h2>
      <button class="btn btn-ghost btn-sm" data-action="pick-all" title="아이디 → 비밀번호 → 버튼 순으로 연속 선택">순서대로 선택</button>
    </div>
    ${selRows}
    <div class="result-actions">
      <button class="btn btn-ghost btn-sm" data-action="verify">현재 탭에서 확인</button>
    </div>
    <p class="muted hint-text">
      <b>선택</b>을 누르고 페이지에서 요소를 클릭하세요 (ESC 취소). id·name 같은 안정적인 속성이 있으면 그것으로 셀렉터를 만듭니다.
    </p>
  </section>

  <section class="card">
    <div class="card-head">
      <h2>로그아웃 <span class="muted">(같은 단축키)</span></h2>
    </div>
    <label class="chk"><input type="checkbox" data-f="autoLogout" ${s.autoLogout !== false ? "checked" : ""} />
      로그인된 상태면 같은 단축키로 <b>로그아웃</b></label>
    <div class="sel-gap">${selRowHTML(FIELDS.find((f) => f.key === "logout"))}</div>
    <p class="muted hint-text">
      <b>로그인 상태 판별</b>에도 쓰입니다 — 이 요소가 페이지에 있으면 로그인된 것으로 보고 로그아웃을 실행하고,
      없으면 자동 로그인을 실행합니다. 로그아웃 링크처럼 <b>로그인했을 때만 생기는 요소</b>를 고르세요.
      (드롭다운 안에 숨어 있어도 괜찮습니다) 비워 두면 로그아웃을 하지 않습니다.
    </p>
  </section>

  <section class="card">
    <div class="card-head">
      <h2>계정</h2>
      <button class="btn btn-primary btn-sm" data-action="add-acc">+ 계정</button>
    </div>
    <div class="acc-list">${accRows}</div>
    ${
      s.accounts.length > 1
        ? '<p class="muted hint-text">계정이 2개 이상이면 단축키 실행 시 <b>페이지에 선택창</b>이 뜹니다. ' +
          '<b>먼저</b>로 지정한 계정이 맨 위에 포커스되어 <b>Enter</b> 한 번으로 실행되고, 숫자키로 다른 계정을 고를 수 있습니다.</p>'
        : ""
    }
  </section>

  <div class="result-actions">
    <button class="btn btn-ghost" data-action="test" title="현재 탭에서 실행 (로그인 상태면 로그아웃)">${icon("play")}지금 실행해 보기</button>
    <button class="btn btn-primary" data-action="save">저장</button>
  </div>`;
}

function selRowHTML(f) {
  if (!f) return "";
  const cur = (editing.sel[f.key] || "");
  const ph = { user: "#username", pass: "#password", submit: "#loginBtn", logout: "a[href*='logout']" };
  const st = selState[f.key];
  return `
    <div class="sel-row">
      <label title="${esc(f.hint || "")}">${f.label}</label>
      <input data-sel="${f.key}" spellcheck="false" placeholder="예) ${esc(ph[f.key] || "")}" value="${esc(cur)}" />
      <button class="btn btn-sm" data-action="pick" data-field="${f.key}">선택</button>
      <span class="sel-state ${st && st.ok === false ? "bad" : ""}">${st ? esc(st.text) : ""}</span>
    </div>`;
}

function accountHTML(a, i, defaultId) {
  const has = !!a.secret;
  const typed = pendingSecrets[a.id] ? true : false;
  return `
  <div class="acc" data-acc-id="${a.id}">
    <div class="acc-top">
      <span class="acc-num">${i + 1}</span>
      <input data-af="label" placeholder="계정 표시 이름 (예: 운영계정)" value="${esc(a.label)}" />
      <label class="chk" title="기본 계정 — 계정이 여러 개일 때 선택창에서 맨 위에 오고 포커스됩니다 (Enter 로 바로 실행)">
        <input type="radio" name="def-acc" data-af="isDefault" ${defaultId === a.id ? "checked" : ""} /> 먼저
      </label>
      <button class="btn btn-icon btn-danger" data-action="del-acc" title="계정 삭제">${icon("trash")}</button>
    </div>
    <input data-af="username" autocomplete="off" placeholder="아이디" value="${esc(a.username)}" />
    <input data-af="password" type="password" autocomplete="new-password"
      placeholder="${has ? "비밀번호 (변경할 때만 입력)" : "비밀번호"}" />
    <div class="acc-state ${has || typed ? "" : "bad"}">${
      typed ? "입력됨 — 저장하면 암호화됩니다" : has ? "암호화되어 저장됨" : "비밀번호 없음"
    }</div>
  </div>`;
}

// ---- 셀렉터 선택 (picker.js 재사용) --------------------------------------
async function pickFor(field) {
  const tab = await getActiveTab();
  if (!tab || !injectable(tab.url)) {
    pickQueue = [];
    return toast("이 페이지에서는 요소를 선택할 수 없어요");
  }
  try {
    await ensurePicker(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: "START_PICK", ruleId: "login:" + field });
    const name = (FIELDS.find((f) => f.key === field) || {}).label || field;
    toast(`페이지에서 '${name}' 요소를 클릭하세요 (ESC 취소)`);
  } catch (e) {
    pickQueue = [];
    toast("주입 실패: " + e.message);
  }
}

// picker.js 의 선택 결과 수신 (sidepanel.js 는 "login:" 접두어를 무시한다)
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg.ruleId !== "string" || !msg.ruleId.startsWith("login:")) return;
  if (msg.type === "PICK_CANCELLED") {
    pickQueue = [];
    return;
  }
  if (msg.type !== "ELEMENT_PICKED" || !editing) return;

  const field = msg.ruleId.slice("login:".length);
  editing.sel[field] = msg.selector || "";
  selState[field] = { ok: true, text: "선택됨" };

  // 비밀번호 칸에 비밀번호가 아닌 요소를 고르면 알려준다
  if (field === "pass" && msg.isSecret === false) {
    toast("비밀번호 입력창(type=password)이 아닐 수 있어요");
  }
  renderDetail();

  const next = pickQueue.shift();
  if (next) pickFor(next);
});

async function verifySelectors() {
  const tab = await getActiveTab();
  if (!tab || !injectable(tab.url)) return toast("이 페이지에서는 확인할 수 없어요");
  try {
    await ensurePicker(tab.id);
  } catch (e) {
    return toast("주입 실패: " + e.message);
  }
  for (const f of FIELDS) {
    const sel = (editing.sel[f.key] || "").trim();
    if (!sel) {
      selState[f.key] = f.required ? { ok: false, text: "비어 있음" } : null;
      continue;
    }
    if (!isValidSelector(sel)) {
      selState[f.key] = { ok: false, text: "문법 오류" };
      continue;
    }
    // source:"attr" 로 조회해 값(특히 비밀번호)을 읽지 않는다
    const resp = await chrome.tabs
      .sendMessage(tab.id, { type: "EXTRACT", selector: sel, index: 0, source: "attr", attrName: "id" })
      .catch(() => null);
    selState[f.key] = resp && resp.found ? { ok: true, text: "찾음" } : { ok: false, text: "못 찾음" };
  }
  renderDetail();
}

// ---- 저장 ----------------------------------------------------------------
async function saveDetail() {
  const s = editing;
  if (!s) return;

  const d = describeSiteUrl(s.url);
  if (!d) return toast("URL 형식이 올바르지 않습니다 (http:// 또는 https://)");
  s.origin = d.origin;
  s.path = d.path;
  if (!(s.name || "").trim()) s.name = d.origin.replace(/^https?:\/\//, "");

  for (const f of FIELDS) {
    const sel = (s.sel[f.key] || "").trim();
    s.sel[f.key] = sel;
    if (sel && !isValidSelector(sel)) return toast(`${f.label} 셀렉터 문법이 올바르지 않습니다`);
  }
  if (!s.sel.user || !s.sel.pass) {
    return toast("아이디·비밀번호 셀렉터는 반드시 필요합니다");
  }
  if (s.autoLogout !== false && !s.sel.logout) s.autoLogout = false; // 셀렉터가 없으면 자동으로 끈다

  const typedIds = Object.keys(pendingSecrets).filter((k) => pendingSecrets[k]);
  if (typedIds.length) {
    const key = await vault.getUnlockedKey();
    if (!key) {
      toast("자동 잠금되었어요 — 다시 잠금 해제한 뒤 저장하세요");
      return refreshAll();
    }
    for (const acc of s.accounts) {
      const plain = pendingSecrets[acc.id];
      if (plain) acc.secret = await encryptSecret(key, plain);
    }
    await vault.touchUnlock();
  }

  try {
    await store.saveSite(s);
  } catch (e) {
    return toast("저장 실패: " + e.message);
  }
  wipeSecrets();
  toast("저장됨");
  closeDetail();
  await refreshAll();
}

// ---- 설정 화면 ------------------------------------------------------------
function remainText(expiresAt) {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "";
  const m = Math.ceil(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분 남음` : `${m}분 남음`;
}

async function renderSettings(st) {
  const s = st || (await vault.status());
  $("#sec-status").textContent = !s.initialized
    ? "미설정"
    : s.unlocked
      ? `해제됨 · ${remainText(s.expiresAt)}`
      : "잠김";
  $("#auto-lock-min").value = String(s.autoLockMinutes);
  $("#btn-toggle-change-master").classList.toggle("hidden", !s.initialized);

  const shortcutHint = $("#login-shortcut-hint");
  if (shortcutHint) {
    const hk = normalizeHotkey((await store.getSettings()).hotkey);
    shortcutHint.innerHTML = hk.enabled
      ? `등록한 사이트에서 <span class="kbd">${esc(displayCombo(hk.combo, IS_MAC))}</span> → <b>로그인</b>, 이미 로그인된 상태면 <b>로그아웃</b>합니다.`
      : "단축키가 꺼져 있어요 — <b>설정 → 단축키</b>에서 켜세요.";
  }

  await renderPageHotkey();

  const sync = await store.syncStatus();
  $("#sync-badge").textContent = sync.ok ? `${sync.percent}% 사용` : "확인 실패";
  $("#usage-bar").style.width = `${sync.percent}%`;
  $("#usage-bar").classList.toggle("warn", sync.percent >= 80);
  $("#sync-info").textContent = sync.ok
    ? `사이트 ${sync.siteCount}개 · ${sync.bytes.toLocaleString()} / ${sync.quota.toLocaleString()} 바이트 (항목당 최대 8,192B)`
    : sync.message;
}

// ---- 페이지 내 단축키 (F2 / F4 / Ctrl+Shift+Y) ----------------------------
// Chrome commands API 는 Ctrl/Alt 를 반드시 포함해야 하고 F1~F12 를 지원하지 않으며, 키를 바꾸려면
// chrome://extensions/shortcuts 로 가야 한다. 그래서 모든 단축키를 페이지에 심은 콘텐츠 스크립트로 받는다.
const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent || "");

const HK = {
  auth: {
    key: "hotkey",
    fallback: "F2",
    keyEl: "#page-hotkey",
    btn: "#btn-capture-hotkey",
    chk: "#page-hotkey-enabled",
    label: "로그인/로그아웃",
  },
  panel: {
    key: "panelHotkey",
    fallback: DEFAULT_PANEL_COMBO,
    keyEl: "#panel-hotkey",
    btn: "#btn-capture-panel-hotkey",
    chk: "#panel-hotkey-enabled",
    label: "패널 열기/닫기",
  },
  copy: {
    key: "copyHotkey",
    fallback: DEFAULT_COPY_COMBO,
    keyEl: "#copy-hotkey",
    btn: "#btn-capture-copy-hotkey",
    chk: "#copy-hotkey-enabled",
    label: "추출 결과 복사",
  },
};
const HK_KINDS = Object.keys(HK);
// 같은 키가 겹치면 hotkey.js 의 판단 순서(패널 → 로그인 → 복사)대로 앞쪽이 동작한다

async function renderPageHotkey() {
  const st = await store.getSettings();
  const vals = {};
  for (const kind of HK_KINDS) vals[kind] = normalizeHotkey(st[HK[kind].key], HK[kind].fallback);

  for (const kind of HK_KINDS) {
    const cfg = HK[kind];
    const hk = vals[kind];
    const keyEl = $(cfg.keyEl);
    if (capturing !== kind) {
      keyEl.textContent = displayCombo(hk.combo, IS_MAC);
      keyEl.classList.remove("capturing");
    }
    $(cfg.chk).checked = hk.enabled;
    $(cfg.btn).disabled = !hk.enabled;
  }

  const allSites = st.hotkeyAllSites !== false;
  $("#hotkey-all-sites").checked = allSites;

  // 사이트 목록은 잠금 해제와 무관하게 읽을 수 있다(비밀번호만 키가 필요) → 잠긴 상태에서도 정확히 센다
  const all = sites.length ? sites : await store.loadSites().catch(() => []);
  const count = toMatchPatterns(all).length;

  const notes = [];
  if (HK_KINDS.every((k) => !vals[k].enabled)) {
    notes.push("모두 꺼져 있어 단축키가 동작하지 않습니다.");
  } else if (allSites) {
    notes.push("모든 http(s) 페이지에서 동작합니다.");
  } else if (count) {
    notes.push(`로그인 등록 <b>${count}개</b> 사이트와 추출 규칙이 있는 사이트에서만 동작합니다.`);
  } else {
    notes.push(
      "로그인 등록 사이트·추출 규칙이 있는 사이트에서만 동작합니다. (현재 로그인 등록 사이트 0개)"
    );
  }
  notes.push("페이지에 포커스가 있어야 하며, 주소창에 포커스가 있으면 동작하지 않습니다.");
  for (const kind of HK_KINDS) {
    if (vals[kind].enabled && needsTypingGuard(vals[kind].combo)) {
      notes.push(
        `<b>${esc(displayCombo(vals[kind].combo, IS_MAC))}</b> 는 수정자가 없는 일반 키라서 입력창에 포커스가 있을 때는 무시합니다.`
      );
    }
  }
  HK_KINDS.forEach((a, i) =>
    HK_KINDS.slice(i + 1).forEach((b) => {
      if (hotkeyConflict(vals[a], vals[b])) {
        notes.push(
          `<span class="err-text">${HK[a].label}·${HK[b].label} 단축키가 같습니다 — ${HK[a].label}이(가) 우선 동작합니다.</span>`
        );
      }
    })
  );
  notes.push("페이지가 같은 키를 쓰면 충돌할 수 있습니다. 그때는 다른 키로 바꾸세요.");
  $("#page-hotkey-note").innerHTML = notes.join(" ");
}

function stopCapture() {
  const kind = capturing;
  capturing = null;
  window.removeEventListener("keydown", onCaptureKey, true);
  if (kind) $(HK[kind].btn).textContent = "키 지정";
}

async function onCaptureKey(e) {
  const kind = capturing;
  if (!kind) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") {
    stopCapture();
    await renderPageHotkey();
    toast("키 지정을 취소했어요");
    return;
  }
  const combo = comboFromEvent(e);
  if (!combo) return; // 수정자만 누른 상태 — 계속 대기
  stopCapture();
  await store.setSettings({ [HK[kind].key]: { combo, enabled: true } });
  await renderPageHotkey();
  toast(`${HK[kind].label} 단축키를 ${displayCombo(combo, IS_MAC)} 로 지정했어요`);
}

function startCapture(kind) {
  if (capturing === kind) {
    stopCapture();
    renderPageHotkey();
    return;
  }
  if (capturing) stopCapture();
  capturing = kind;
  const keyEl = $(HK[kind].keyEl);
  keyEl.textContent = "키를 누르세요…";
  keyEl.classList.add("capturing");
  $(HK[kind].btn).textContent = "취소";
  window.addEventListener("keydown", onCaptureKey, true);
}

async function toggleHotkeyEnabled(kind, enabled) {
  if (capturing) stopCapture();
  const st = await store.getSettings();
  const cur = normalizeHotkey(st[HK[kind].key], HK[kind].fallback);
  await store.setSettings({ [HK[kind].key]: { ...cur, enabled } });
  await renderPageHotkey();
  toast(`${HK[kind].label} 단축키를 ${enabled ? "켰어요" : "껐어요"}`);
}

async function refreshBadges() {
  if (currentView !== "login" && currentView !== "settings") return;
  const st = await vault.status();
  if (!st.unlocked && st.initialized) return refreshAll(); // 만료 → 잠금 화면으로
  await renderSettings(st);
}

// ---- 이벤트 바인딩 --------------------------------------------------------
function bindStaticEvents() {
  // 잠금 화면
  $("#btn-unlock").addEventListener("click", doUnlock);
  ["#master-pw", "#master-pw2"].forEach((sel) =>
    $(sel).addEventListener("keydown", (e) => {
      if (e.key === "Enter") doUnlock();
    })
  );

  // 사이트 목록
  $("#site-search").addEventListener("input", (e) => {
    searchText = e.target.value;
    renderSiteList();
  });

  $("#btn-add-site").addEventListener("click", async () => {
    const tab = await getActiveTab().catch(() => null);
    const s = store.newSite();
    if (tab && tab.url && /^https?:/.test(tab.url)) {
      s.url = tab.url.split(/[?#]/)[0];
      const d = describeSiteUrl(s.url);
      if (d) {
        // 경로 일치는 **자동으로 켜지 않는다.** 로그인 페이지 경로(/login 등)에 묶이면
        // 로그인 후 다른 경로로 이동했을 때 단축키가 동작하지 않는다. 필요하면 사용자가 켠다.
        s.name = (tab.title || d.origin).slice(0, 40);
      }
    }
    openDetail(s);
  });

  $("#btn-lock-now-2").addEventListener("click", async () => {
    await vault.lock();
    toast("잠갔습니다");
    await refreshAll();
  });

  $("#current-match").addEventListener("click", (e) => {
    if (e.target.id === "btn-add-current") $("#btn-add-site").click();
  });

  $("#site-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    const row = e.target.closest("[data-site-id]");
    if (!row) return;
    const site = sites.find((x) => x.id === row.dataset.siteId);
    if (!site) return;

    if (!btn) return openDetail(site); // 행 클릭 = 수정
    switch (btn.dataset.action) {
      case "edit":
        openDetail(site);
        break;
      case "del":
        if (!confirm(`'${site.name || site.origin}' 사이트와 등록된 계정을 모두 삭제할까요?`)) return;
        await store.deleteSite(site.id);
        toast("삭제됨");
        await refreshAll();
        break;
      case "run": {
        const tab = await getActiveTab();
        const r = await chrome.runtime.sendMessage({
          type: "LOGIN_RUN",
          siteId: site.id,
          tabId: tab && tab.id,
        });
        toast(r && r.ok ? "자동 로그인 실행" : (r && r.message) || "실행 실패");
        break;
      }
    }
  });

  // 사이트 상세 (위임)
  const detail = $("#site-detail");

  detail.addEventListener("input", (e) => {
    if (!editing) return;
    const t = e.target;
    if (t.dataset.f === "name" || t.dataset.f === "url") {
      editing[t.dataset.f] = t.value;
      return; // 재렌더하지 않음(입력 포커스 유지)
    }
    if (t.dataset.sel) {
      editing.sel[t.dataset.sel] = t.value;
      return;
    }
    const accEl = t.closest("[data-acc-id]");
    if (accEl && t.dataset.af) {
      const acc = editing.accounts.find((a) => a.id === accEl.dataset.accId);
      if (!acc) return;
      if (t.dataset.af === "password") pendingSecrets[acc.id] = t.value;
      else if (t.dataset.af === "label" || t.dataset.af === "username") acc[t.dataset.af] = t.value;
    }
  });

  detail.addEventListener("change", (e) => {
    if (!editing) return;
    const t = e.target;
    const f = t.dataset.f;
    if (f === "matchPath" || f === "autoLogin" || f === "autoSubmit" || f === "autoLogout") {
      editing[f] = t.checked;
      return;
    }
    if (t.dataset.af === "isDefault") {
      const accEl = t.closest("[data-acc-id]");
      editing.defaultAccountId = accEl ? accEl.dataset.accId : null;
    }
  });

  detail.addEventListener("blur", (e) => {
    // URL 입력을 끝냈을 때 origin/경로 안내를 갱신
    if (editing && e.target.dataset && e.target.dataset.f === "url") renderDetail();
  }, true);

  detail.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn || !editing) return;
    switch (btn.dataset.action) {
      case "close":
        closeDetail();
        break;
      case "pick":
        pickQueue = [];
        pickFor(btn.dataset.field);
        break;
      case "pick-all":
        pickQueue = ["pass", "submit"];
        pickFor("user");
        break;
      case "verify":
        await verifySelectors();
        break;
      case "add-acc":
        editing.accounts.push(store.newAccount());
        if (editing.accounts.length === 1) editing.defaultAccountId = editing.accounts[0].id;
        renderDetail();
        break;
      case "del-acc": {
        const accEl = btn.closest("[data-acc-id]");
        const id = accEl.dataset.accId;
        editing.accounts = editing.accounts.filter((a) => a.id !== id);
        if (editing.defaultAccountId === id) editing.defaultAccountId = null;
        pendingSecrets[id] = null;
        delete pendingSecrets[id];
        renderDetail();
        break;
      }
      case "save":
        await saveDetail();
        break;
      case "test": {
        if (Object.keys(pendingSecrets).some((k) => pendingSecrets[k])) {
          return toast("먼저 저장한 뒤 테스트하세요");
        }
        if (!editing.updatedAt) return toast("먼저 저장한 뒤 테스트하세요");
        const tab = await getActiveTab();
        const r = await chrome.runtime.sendMessage({
          type: "LOGIN_RUN",
          siteId: editing.id,
          tabId: tab && tab.id,
        });
        toast(r && r.ok ? "자동 로그인 실행" : (r && r.message) || "실행 실패");
        break;
      }
    }
  });

  // 설정 화면
  $("#auto-lock-min").addEventListener("change", async (e) => {
    await store.setSettings({ autoLockMinutes: Number(e.target.value) });
    await vault.touchUnlock(); // 새 간격을 즉시 적용
    toast("자동 잠금 시간을 변경했어요");
    await renderSettings();
  });

  $("#btn-lock-now").addEventListener("click", async () => {
    await vault.lock();
    await chrome.runtime.sendMessage({ type: "OTP_LOCK" }).catch(() => {}); // 설정의 「지금 잠그기」는 OTP 도 함께
    toast("잠갔습니다");
    await refreshAll();
  });

  $("#btn-capture-hotkey").addEventListener("click", () => startCapture("auth"));
  $("#btn-capture-panel-hotkey").addEventListener("click", () => startCapture("panel"));
  $("#page-hotkey-enabled").addEventListener("change", (e) =>
    toggleHotkeyEnabled("auth", e.target.checked)
  );
  $("#panel-hotkey-enabled").addEventListener("change", (e) =>
    toggleHotkeyEnabled("panel", e.target.checked)
  );
  $("#btn-capture-copy-hotkey").addEventListener("click", () => startCapture("copy"));
  $("#copy-hotkey-enabled").addEventListener("change", (e) => toggleHotkeyEnabled("copy", e.target.checked));

  $("#hotkey-all-sites").addEventListener("change", async (e) => {
    await store.setSettings({ hotkeyAllSites: e.target.checked });
    await renderPageHotkey();
    toast(
      e.target.checked
        ? "모든 사이트에서 단축키를 사용합니다"
        : "등록된 사이트에서만 단축키를 사용합니다"
    );
  });

  $("#btn-toggle-change-master").addEventListener("click", () => {
    $("#change-master-form").classList.toggle("hidden");
  });

  $("#btn-change-master").addEventListener("click", async () => {
    const err = $("#cm-error");
    const show = (m) => {
      err.textContent = m || "";
      err.classList.toggle("hidden", !m);
    };
    const oldPw = $("#cm-old").value;
    const nw = $("#cm-new").value;
    const nw2 = $("#cm-new2").value;
    show("");
    if (nw.length < 8) return show("새 마스터 비밀번호는 8자 이상이어야 합니다");
    if (nw !== nw2) return show("새 비밀번호가 일치하지 않습니다");
    try {
      const r = await vault.changeMaster(oldPw, nw);
      // OTP 인증기는 같은 마스터 비밀번호로 감싼 별도 키를 쓴다 → 새 비밀번호로 다시 감싼다(항목 재암호화 없음)
      const o = await chrome.runtime
        .sendMessage({ type: "OTP_REWRAP", oldPassword: oldPw, newPassword: nw })
        .catch(() => null);
      const otpNote = o && o.result === "done" ? " · OTP 키도 옮김" : "";
      toast(`변경 완료 (비밀번호 ${r.reencrypted}건 재암호화${otpNote})`);
      $("#change-master-form").classList.add("hidden");
    } catch (e) {
      return show(e.message);
    } finally {
      $("#cm-old").value = "";
      $("#cm-new").value = "";
      $("#cm-new2").value = "";
    }
    await refreshAll();
  });

  // 다른 PC에서의 변경(동기화) 반영
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    const touched = Object.keys(changes).some(
      (k) => k.startsWith("ua_site_") || k === store.K_INDEX || k === store.K_VAULT
    );
    if (!touched) return;
    if (currentView !== "login" && currentView !== "settings") return;
    if (editing) {
      toast("다른 기기에서 변경됨 — 저장하면 이 내용이 최신이 됩니다");
      return; // 편집 중인 입력을 덮어쓰지 않는다
    }
    refreshAll();
  });
}
