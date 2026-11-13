// 사이드 패널 컨트롤러 — 메뉴 전환 + (텍스트 추출) 상태 관리·요소 선택/추출·변환·조합·프리셋·단축키 설정
// 자동 로그인 화면은 독립 모듈 `login.js` 가 담당한다.
import { icon } from "./icons.js";
import { applyTransforms, combineResults } from "../lib/transform.js";
import { ensurePicker, getActiveTab, injectable } from "../lib/tabs.js";
import { initLoginUI, onViewShown } from "./login.js";
import { initApprovalUI, onApprovalShown } from "./approval.js";
import { initBackupUI } from "./backup.js";
import { DEFAULT_COPY_COMBO, DEFAULT_PANEL_COMBO, comboFromEvent, isTypingTarget, needsTypingGuard, normalizeHotkey } from "../lib/hotkey.js";
import { K_SETTINGS } from "../lib/login-store.js";
import { K_NAV_ORDER, moveItem, normalizeOrder } from "../lib/nav-order.js";
import {
  DEFAULT_COMBINE,
  K_SITE_RULES,
  migrateLegacyStorage,
  normalizeSiteState,
  putSiteState,
  siteKeyFromUrl,
} from "../lib/site-rules.js";

// ---- 상태 ----------------------------------------------------------------
// 규칙은 사이트별로 저장된다(../lib/site-rules.js). `state` 는 현재 탭 사이트의 묶음이다.
let siteKey = null; // 현재 탭의 사이트 (규칙을 쓸 수 없는 페이지면 null)
let state = normalizeSiteState(null);
let pickingRuleId = null; // 현재 요소 선택 대기 중인 규칙(영속 X)
const advOpen = new Set(); // 「고급 설정」을 펼쳐 둔 규칙 (다시 그려도 유지)

const $ = (sel, root = document) => root.querySelector(sel);
const rulesEl = $("#rules");
const resultEl = $("#result");
const emptyHint = $("#empty-hint");

const uid = () =>
  (crypto.randomUUID && crypto.randomUUID()) || "r" + Date.now() + Math.random().toString(36).slice(2);

const escAttr = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function newRule() {
  return {
    id: uid(),
    name: "",
    selector: "",
    index: 0,
    source: "innerText",
    attrName: "",
    rawText: "",
    transforms: [{ find: "", replace: "", isRegex: false, flags: "g" }],
    trim: true,
    enabled: true,
    missing: false,
  };
}

function defaultName(r) {
  const txt = (r.rawText || "").trim().replace(/\s+/g, " ");
  if (txt) return txt.length > 18 ? txt.slice(0, 18) + "…" : txt;
  if (r.selector) return r.selector.split(">").pop().trim();
  return "규칙";
}

// ---- 저장/불러오기 -------------------------------------------------------
let saveTimer = null;
let pendingSave = null; // { key, state } — 사이트를 바꾸기 전에 마저 저장한다

async function writeSiteState(key, st) {
  const { [K_SITE_RULES]: all } = await chrome.storage.local.get(K_SITE_RULES);
  await chrome.storage.local.set({ [K_SITE_RULES]: putSiteState(all, key, st) });
}

function saveStateDebounced() {
  if (!siteKey) return;
  pendingSave = { key: siteKey, state };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 250);
}

async function flushSave() {
  clearTimeout(saveTimer);
  const p = pendingSave;
  pendingSave = null;
  if (p) await writeSiteState(p.key, p.state);
}

async function loadState(key) {
  const { [K_SITE_RULES]: all } = await chrome.storage.local.get(K_SITE_RULES);
  state = normalizeSiteState(key && all ? all[key] : null);
}

// ---- 계산/렌더 -----------------------------------------------------------
function computeAll() {
  return state.rules.map((r) => {
    const { result, error } = applyTransforms(r.rawText, r);
    return { result, error, enabled: r.enabled };
  });
}

function recompute() {
  const computed = computeAll();
  state.rules.forEach((r, i) => {
    const el = rulesEl.querySelector(`[data-result="${r.id}"]`);
    if (!el) return;
    const c = computed[i];
    el.classList.toggle("error", !!c.error);
    el.textContent = c.error
      ? c.error
      : r.missing
        ? "이 페이지에서 요소를 찾지 못했어요"
        : c.result === ""
          ? "(빈 값)"
          : c.result;
  });
  resultEl.value = combineResults(computed, state.combine);
  saveStateDebounced();
}

// 기본으로는 이름·결과만 보이고, 추출 대상·변환 등은 「고급 설정」 안에 둔다
function hasAdvanced(r) {
  const xf = (r.transforms || []).some((x) => x.find);
  return xf || (r.source && r.source !== "innerText") || r.trim === false || r.enabled === false;
}

function ruleCardHTML(r, num) {
  const t = r.transforms || [];
  const xfRows = t
    .map(
      (x, i) => `
    <div class="xf" data-xf-index="${i}">
      <input data-field="find" placeholder="찾을 내용" value="${escAttr(x.find)}" />
      <input data-field="replace" placeholder="바꿀 내용(비움=삭제)" value="${escAttr(x.replace)}" />
      <label class="xf-regex"><input type="checkbox" data-field="isRegex" ${x.isRegex ? "checked" : ""}/>정규식</label>
      <input class="flags" data-field="flags" title="플래그 (예: gi)" value="${escAttr(x.flags || "g")}" ${x.isRegex ? "" : "disabled"} />
      <button class="btn btn-icon" data-action="xf-remove" title="이 변환 삭제">${icon("x")}</button>
    </div>`
    )
    .join("");

  return `
  <div class="rule ${r.enabled ? "" : "disabled"} ${pickingRuleId === r.id ? "picking" : ""}" data-rule-id="${r.id}">
    <div class="rule-top">
      <span class="rule-num">${num}</span>
      <input class="rule-name" data-field="name" placeholder="이름" value="${escAttr(r.name)}" />
      <div class="rule-tools">
        <button class="btn btn-icon" data-action="reselect" title="요소 다시 선택">${icon("target")}</button>
        <button class="btn btn-icon" data-action="up" title="위로">${icon("up")}</button>
        <button class="btn btn-icon" data-action="down" title="아래로">${icon("down")}</button>
        <button class="btn btn-icon btn-danger" data-action="delete" title="삭제">${icon("trash")}</button>
      </div>
    </div>

    <div class="rule-result ${r.missing ? "missing" : ""}" data-result="${r.id}"></div>

    <details class="adv rule-adv" ${advOpen.has(r.id) ? "open" : ""}>
      <summary>고급 설정${hasAdvanced(r) ? ' <span class="adv-on">적용 중</span>' : ""}</summary>
      <div class="adv-body">
        <div class="rule-selector">
          <code class="${r.missing ? "missing" : ""}" data-selector>${escAttr(r.selector || "(선택 안 됨)")}</code>
          <button class="btn btn-sm btn-icon" data-action="refresh" title="이 페이지에서 다시 읽기">${icon("refresh")}</button>
        </div>

        <div class="rule-source">
          <select data-field="source">
            <option value="innerText" ${r.source === "innerText" ? "selected" : ""}>텍스트</option>
            <option value="textContent" ${r.source === "textContent" ? "selected" : ""}>텍스트(숨김포함)</option>
            <option value="value" ${r.source === "value" ? "selected" : ""}>입력값</option>
            <option value="attr" ${r.source === "attr" ? "selected" : ""}>속성</option>
          </select>
          <input class="attr-name ${r.source === "attr" ? "" : "hidden"}" data-field="attrName" placeholder="속성명 (예: href)" value="${escAttr(r.attrName)}" />
        </div>

        <div class="transforms">${xfRows}</div>
        <button class="btn btn-sm btn-ghost" data-action="xf-add">+ 찾아 바꾸기 추가</button>

        <div class="rule-foot">
          <label><input type="checkbox" data-field="trim" ${r.trim ? "checked" : ""}/> 앞뒤 공백 제거</label>
          <label><input type="checkbox" data-field="enabled" ${r.enabled ? "checked" : ""}/> 결과에 포함</label>
        </div>
      </div>
    </details>
  </div>`;
}

function renderRules() {
  rulesEl.innerHTML = state.rules.map((r, i) => ruleCardHTML(r, i + 1)).join("");
  emptyHint.classList.toggle("hidden", state.rules.length > 0 || !siteKey);
  recompute();
}

// <details> 의 toggle 은 버블링되지 않으므로 캡처 단계에서 받는다
rulesEl.addEventListener(
  "toggle",
  (e) => {
    if (!e.target.matches || !e.target.matches("details.rule-adv")) return;
    const card = e.target.closest("[data-rule-id]");
    if (!card) return;
    if (e.target.open) advOpen.add(card.dataset.ruleId);
    else advOpen.delete(card.dataset.ruleId);
  },
  true
);

function renderCombineControls() {
  $("#separator").value = state.combine.separator;
  $("#custom-sep").value = state.combine.customSep || "";
  $("#custom-sep").classList.toggle("hidden", state.combine.separator !== "custom");
  $("#template").value = state.combine.template || "";
  const isTpl = state.combine.mode === "template";
  $("#join-opts").classList.toggle("hidden", isTpl);
  $("#template-opts").classList.toggle("hidden", !isTpl);
  $$(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.combine.mode));
  if (isTpl) $("#combine-adv").open = true; // 템플릿을 쓰는 중이면 설정을 감추지 않는다
}
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---- 요소 선택 / 추출 (콘텐츠 스크립트 연동) -----------------------------
// getActiveTab / injectable / ensurePicker 는 ../lib/tabs.js 공용 헬퍼

async function startPicking(ruleId) {
  const tab = await getActiveTab();
  if (!tab || !injectable(tab.url)) {
    toast("이 페이지에서는 요소를 선택할 수 없어요");
    return;
  }
  try {
    await ensurePicker(tab.id);
    pickingRuleId = ruleId;
    renderRules();
    await chrome.tabs.sendMessage(tab.id, { type: "START_PICK", ruleId });
    toast("페이지에서 요소를 클릭하세요 (ESC 취소)");
  } catch (e) {
    pickingRuleId = null;
    renderRules();
    toast("주입 실패: " + e.message);
  }
}

async function refreshRule(rule) {
  const tab = await getActiveTab();
  if (!tab || !injectable(tab.url) || !rule.selector) {
    rule.missing = !!rule.selector;
    return;
  }
  try {
    await ensurePicker(tab.id);
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: "EXTRACT",
      selector: rule.selector,
      index: rule.index,
      source: rule.source,
      attrName: rule.attrName,
    });
    if (resp && resp.found) {
      rule.rawText = resp.rawText;
      rule.missing = false;
    } else {
      rule.missing = true;
    }
  } catch (e) {
    rule.missing = true;
  }
}

async function refreshAll({ quiet = false } = {}) {
  const key = siteKey;
  for (const r of state.rules) await refreshRule(r);
  if (key !== siteKey) return; // 읽는 사이에 다른 사이트로 바뀜
  renderRules();
  if (!quiet) toast("현재 페이지에서 다시 읽었어요");
}

// 콘텐츠 스크립트로부터의 메시지 수신
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  // 자동 로그인 셀렉터 선택(ruleId: "login:*")은 login.js 가 처리한다
  if (typeof msg.ruleId === "string" && msg.ruleId.startsWith("login:")) return;
  if (msg.type === "ELEMENT_PICKED") {
    const r = state.rules.find((x) => x.id === msg.ruleId);
    if (r) {
      r.selector = msg.selector || "";
      r.index = msg.index || 0;
      r.source = msg.source || "innerText";
      r.rawText = msg.rawText || "";
      r.missing = false;
      if (!r.name) r.name = defaultName(r);
    }
    pickingRuleId = null;
    renderRules();
    toast("요소를 가져왔어요");
  } else if (msg.type === "PICK_CANCELLED") {
    pickingRuleId = null;
    renderRules();
  }
});

// ---- 이벤트: 규칙 영역 (위임) -------------------------------------------
function getRule(node) {
  const card = node.closest("[data-rule-id]");
  if (!card) return null;
  return state.rules.find((r) => r.id === card.dataset.ruleId) || null;
}
function getXf(node, rule) {
  const row = node.closest("[data-xf-index]");
  if (!row || !rule) return null;
  return rule.transforms[parseInt(row.dataset.xfIndex, 10)] || null;
}

rulesEl.addEventListener("input", (e) => {
  const rule = getRule(e.target);
  if (!rule) return;
  const f = e.target.dataset.field;
  if (!f) return;
  const xf = getXf(e.target, rule);
  if (xf && (f === "find" || f === "replace" || f === "flags")) {
    xf[f] = e.target.value;
  } else if (f === "name" || f === "attrName") {
    rule[f] = e.target.value;
  } else {
    return;
  }
  recompute();
});

rulesEl.addEventListener("change", async (e) => {
  const rule = getRule(e.target);
  if (!rule) return;
  const f = e.target.dataset.field;
  const xf = getXf(e.target, rule);
  if (xf && f === "isRegex") {
    xf.isRegex = e.target.checked;
    renderRules();
    return;
  }
  if (f === "trim" || f === "enabled") {
    rule[f] = e.target.checked;
    renderRules();
    return;
  }
  if (f === "source") {
    rule.source = e.target.value;
    await refreshRule(rule);
    renderRules();
    return;
  }
  if (f === "attrName") {
    rule.attrName = e.target.value;
    if (rule.source === "attr") await refreshRule(rule);
    renderRules();
  }
});

rulesEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const rule = getRule(btn);
  const action = btn.dataset.action;
  const idx = state.rules.indexOf(rule);

  switch (action) {
    case "reselect":
      startPicking(rule.id);
      break;
    case "refresh":
      await refreshRule(rule);
      renderRules();
      break;
    case "delete":
      state.rules.splice(idx, 1);
      renderRules();
      break;
    case "up":
      if (idx > 0) {
        [state.rules[idx - 1], state.rules[idx]] = [state.rules[idx], state.rules[idx - 1]];
        renderRules();
      }
      break;
    case "down":
      if (idx < state.rules.length - 1) {
        [state.rules[idx + 1], state.rules[idx]] = [state.rules[idx], state.rules[idx + 1]];
        renderRules();
      }
      break;
    case "xf-add":
      rule.transforms.push({ find: "", replace: "", isRegex: false, flags: "g" });
      renderRules();
      break;
    case "xf-remove": {
      const xi = parseInt(btn.closest("[data-xf-index]").dataset.xfIndex, 10);
      rule.transforms.splice(xi, 1);
      if (rule.transforms.length === 0)
        rule.transforms.push({ find: "", replace: "", isRegex: false, flags: "g" });
      renderRules();
      break;
    }
  }
});

// ---- 이벤트: 헤더 / 조합 / 복사 -----------------------------------------
$("#btn-add-rule").addEventListener("click", () => {
  if (!siteKey) {
    toast("이 페이지에서는 요소를 선택할 수 없어요");
    return;
  }
  const r = newRule();
  state.rules.push(r);
  renderRules();
  startPicking(r.id);
});

$("#mode-seg").addEventListener("click", (e) => {
  const b = e.target.closest(".seg-btn");
  if (!b) return;
  state.combine.mode = b.dataset.mode;
  renderCombineControls();
  recompute();
});

$("#separator").addEventListener("change", (e) => {
  state.combine.separator = e.target.value;
  renderCombineControls();
  recompute();
});
$("#custom-sep").addEventListener("input", (e) => {
  state.combine.customSep = e.target.value;
  recompute();
});
$("#template").addEventListener("input", (e) => {
  state.combine.template = e.target.value;
  recompute();
});

$("#btn-refresh").addEventListener("click", () => refreshAll());

$("#btn-copy").addEventListener("click", async () => {
  const text = resultEl.value;
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    resultEl.removeAttribute("readonly");
    resultEl.select();
    document.execCommand("copy");
    resultEl.setAttribute("readonly", "");
  }
  toast("복사됨");
});

// ---- 프리셋 --------------------------------------------------------------
async function getPresets() {
  const { presets } = await chrome.storage.local.get("presets");
  return Array.isArray(presets) ? presets : [];
}
async function setPresets(list) {
  await chrome.storage.local.set({ presets: list });
}

async function renderPresets() {
  const list = await getPresets();
  const ul = $("#preset-list");
  ul.innerHTML = list
    .map(
      (p) => `
    <li class="preset-item" data-preset-id="${p.id}">
      <span class="pname">${escAttr(p.name)} <span class="muted">· 규칙 ${p.rules.length}개</span></span>
      <span class="pacts">
        <button class="btn btn-sm" data-action="load">불러오기</button>
        <button class="btn btn-sm btn-danger" data-action="del">삭제</button>
      </span>
    </li>`
    )
    .join("");
}

$("#btn-save-preset").addEventListener("click", async () => {
  const nameInput = $("#preset-name");
  const name = nameInput.value.trim();
  if (!name) {
    toast("프리셋 이름을 입력하세요");
    nameInput.focus();
    return;
  }
  const list = await getPresets();
  list.push({
    id: uid(),
    name,
    rules: JSON.parse(JSON.stringify(state.rules)),
    combine: { ...state.combine },
  });
  await setPresets(list);
  nameInput.value = "";
  renderPresets();
  toast("프리셋 저장됨");
});

$("#preset-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const li = btn.closest("[data-preset-id]");
  const id = li.dataset.presetId;
  const list = await getPresets();
  const p = list.find((x) => x.id === id);
  if (!p) return;

  if (btn.dataset.action === "load") {
    if (!siteKey) return toast("이 페이지에서는 규칙을 쓸 수 없어요");
    state.rules = JSON.parse(JSON.stringify(p.rules));
    state.combine = { ...DEFAULT_COMBINE, ...p.combine };
    renderCombineControls();
    renderRules();
    saveStateDebounced();
    toast(`'${p.name}' 불러옴`);
  } else if (btn.dataset.action === "del") {
    await setPresets(list.filter((x) => x.id !== id));
    renderPresets();
  }
});

// ---- 토스트 --------------------------------------------------------------
let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 1600);
}

// ---- 패널에 포커스가 있을 때의 단축키 (F4 닫기, 복사) ------------------------
// 패널에 포커스가 있으면 키 입력이 페이지로 가지 않아 콘텐츠 스크립트(hotkey.js)가 받지 못한다.
// 패널 문서에서 같은 키를 받아 직접 처리한다. (키 지정 중에는 login.js 가 캡처 단계에서 먼저 가로챈다)
(function panelHotkeys() {
  let hotkey = normalizeHotkey(null, DEFAULT_PANEL_COMBO);
  let copyHotkey = normalizeHotkey(null, DEFAULT_COPY_COMBO);
  const apply = (s) => {
    hotkey = normalizeHotkey(s && s.panelHotkey, DEFAULT_PANEL_COMBO);
    copyHotkey = normalizeHotkey(s && s.copyHotkey, DEFAULT_COPY_COMBO);
  };
  chrome.storage.sync.get(K_SETTINGS).then((bag) => apply(bag[K_SETTINGS]));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[K_SETTINGS]) apply(changes[K_SETTINGS].newValue);
  });
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    const combo = comboFromEvent(e);
    if (!combo || (needsTypingGuard(combo) && isTypingTarget(e.target))) return;
    if (hotkey.enabled && combo === hotkey.combo) {
      e.preventDefault();
      window.close(); // 사이드 패널 문서에서 window.close() 는 패널을 닫는다
    } else if (copyHotkey.enabled && combo === copyHotkey.combo && state.rules.length) {
      e.preventDefault();
      $("#btn-copy").click(); // 패널에 보이는 결과를 그대로 복사
    }
  });
})();

// ---- 패널 열림 상태 알리기 (F4 토글용) -----------------------------------
// sidePanel 에는 "열려 있는지" 묻는 API 가 없어서, 패널이 살아 있는 동안 포트를 연결해 둔다.
// 서비스 워커가 재시작되면 포트가 끊기므로 다시 연결한다.
(function keepPanelPort() {
  let retry = null;
  async function connect() {
    try {
      const win = await chrome.windows.getCurrent();
      const port = chrome.runtime.connect({ name: "ua-sidepanel:" + win.id });
      port.onDisconnect.addListener(() => {
        clearTimeout(retry);
        retry = setTimeout(connect, 500);
      });
    } catch (_) {
      clearTimeout(retry);
      retry = setTimeout(connect, 1000);
    }
  }
  connect();
})();

// ---- 메뉴(뷰) 전환 -------------------------------------------------------
const VIEWS = ["extract", "login", "approval", "settings"];
initApprovalUI();
initBackupUI({ toast });

function showView(name) {
  VIEWS.forEach((v) => $(`#view-${v}`).classList.toggle("hidden", v !== name));
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  onViewShown(name); // 자동 로그인/설정 화면은 열릴 때마다 최신 상태로
  if (name === "approval") onApprovalShown();
}

$("#nav").addEventListener("click", (e) => {
  const b = e.target.closest(".nav-btn");
  if (b) showView(b.dataset.view);
});

// ---- 메뉴 순서: 드래그로 변경 ----------------------------------------------
// 순서는 storage.sync(`ua_nav_order`)에 저장 → 다른 PC 와 동기화, 백업에도 포함된다.
(function navOrder() {
  const nav = $("#nav");
  const buttons = () => $$(".nav-btn", nav);
  const currentOrder = () => buttons().map((b) => b.dataset.view);

  function apply(order) {
    const byView = new Map(buttons().map((b) => [b.dataset.view, b]));
    normalizeOrder(order, VIEWS).forEach((v) => {
      const b = byView.get(v);
      nav.appendChild(b);
      b.title = "드래그해서 순서 변경";
    });
  }

  apply(null);
  chrome.storage.sync.get(K_NAV_ORDER).then((bag) => apply(bag[K_NAV_ORDER]));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[K_NAV_ORDER]) apply(changes[K_NAV_ORDER].newValue);
  });

  // 드래그 앤 드롭
  let dragging = null;
  const clearMarks = () => buttons().forEach((b) => b.classList.remove("drop-before", "drop-after"));
  buttons().forEach((b) => (b.draggable = true));

  nav.addEventListener("dragstart", (e) => {
    const b = e.target.closest(".nav-btn");
    if (!b) return;
    dragging = b.dataset.view;
    b.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragging);
  });

  const dropTarget = (e) => {
    const b = e.target.closest(".nav-btn");
    if (!dragging || !b || b.dataset.view === dragging) return null;
    const r = b.getBoundingClientRect();
    return { b, before: e.clientX < r.left + r.width / 2 };
  };

  nav.addEventListener("dragover", (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    clearMarks();
    const t = dropTarget(e);
    if (t) t.b.classList.add(t.before ? "drop-before" : "drop-after");
  });

  nav.addEventListener("dragleave", (e) => {
    if (!nav.contains(e.relatedTarget)) clearMarks();
  });

  nav.addEventListener("drop", (e) => {
    e.preventDefault();
    const t = dropTarget(e);
    clearMarks();
    if (!t) return;
    const next = moveItem(currentOrder(), dragging, t.b.dataset.view, t.before);
    apply(next);
    chrome.storage.sync.set({ [K_NAV_ORDER]: next }).catch(() => toast("메뉴 순서를 저장하지 못했습니다"));
  });

  nav.addEventListener("dragend", () => {
    buttons().forEach((b) => b.classList.remove("dragging"));
    clearMarks();
    dragging = null;
  });
})();

// ---- 현재 탭 사이트 따라가기 ------------------------------------------------
// 탭을 옮기거나 다른 사이트로 이동하면 그 사이트의 규칙으로 바꾸고, 페이지에서 값을 다시 읽는다.
let switching = Promise.resolve();
function switchSite() {
  switching = switching
    .then(async () => {
      const tab = await getActiveTab().catch(() => null);
      const key = siteKeyFromUrl(tab && tab.url);
      if (key !== siteKey) {
        await flushSave();
        siteKey = key;
        pickingRuleId = null;
        advOpen.clear();
        await loadState(key);
        renderSiteBar();
        renderCombineControls();
        renderRules();
      }
      if (siteKey && state.rules.length && tab && tab.status === "complete") await refreshAll({ quiet: true });
    })
    .catch((e) => console.error("[uni-assist] 사이트 전환 실패:", e));
  return switching;
}

function renderSiteBar() {
  $("#site-host").textContent = siteKey === "file" ? "로컬 파일" : siteKey || "규칙을 쓸 수 없는 페이지";
  $("#site-bar").classList.toggle("off", !siteKey);
  $("#btn-add-rule").disabled = !siteKey;
}

chrome.tabs.onActivated.addListener(() => switchSite());
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url && info.status !== "complete") return;
  const tab = await getActiveTab().catch(() => null);
  if (tab && tab.id === tabId) switchSite();
});
chrome.windows.onFocusChanged.addListener(() => switchSite());
window.addEventListener("pagehide", () => flushSave());

// ---- 초기화 --------------------------------------------------------------
(async function init() {
  $("#app-version").textContent = `v${chrome.runtime.getManifest().version}`;
  await migrateLegacyStorage(chrome.storage.local, uid).catch(() => {});
  await switchSite();
  renderPresets();
  await initLoginUI({ showView, toast });

  // 단축키로 자동 로그인을 시도했는데 잠겨 있어 패널이 열린 경우 → 바로 잠금 화면으로
  try {
    const r = await chrome.runtime.sendMessage({ type: "LOGIN_HAS_PENDING" });
    if (r && r.pending) showView("login");
  } catch (_) {
    /* 서비스 워커 미기동 등 */
  }
})();
