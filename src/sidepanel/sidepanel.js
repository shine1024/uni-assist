// 사이드 패널 컨트롤러 — 상태 관리, 요소 선택/추출, 변환·조합, 프리셋, 단축키 설정
import { applyTransforms, combineResults } from "../lib/transform.js";
import { parsePatterns } from "../lib/match.js";

const DEFAULT_PATTERNS = ["https://labdev.unipost.co.kr/redmine"];

// ---- 상태 ----------------------------------------------------------------
const DEFAULT_COMBINE = { mode: "join", separator: "space", customSep: "", template: "" };

let state = { rules: [], combine: { ...DEFAULT_COMBINE } };
let pickingRuleId = null; // 현재 요소 선택 대기 중인 규칙(영속 X)

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
function saveStateDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ current: state }), 250);
}

async function loadState() {
  const { current } = await chrome.storage.local.get("current");
  if (current && Array.isArray(current.rules)) {
    state = {
      rules: current.rules,
      combine: { ...DEFAULT_COMBINE, ...(current.combine || {}) },
    };
  }
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
    el.textContent = c.error ? "⚠ " + c.error : c.result === "" ? "(빈 값)" : c.result;
  });
  resultEl.value = combineResults(computed, state.combine);
  saveStateDebounced();
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
      <button class="btn btn-icon" data-action="xf-remove" title="이 변환 삭제">✕</button>
    </div>`
    )
    .join("");

  return `
  <div class="rule ${r.enabled ? "" : "disabled"} ${pickingRuleId === r.id ? "picking" : ""}" data-rule-id="${r.id}">
    <div class="rule-top">
      <span class="rule-num">${num}</span>
      <input class="rule-name" data-field="name" placeholder="규칙 이름" value="${escAttr(r.name)}" />
      <div class="rule-tools">
        <button class="btn btn-icon" data-action="up" title="위로">↑</button>
        <button class="btn btn-icon" data-action="down" title="아래로">↓</button>
        <button class="btn btn-icon btn-danger" data-action="delete" title="규칙 삭제">🗑</button>
      </div>
    </div>

    <div class="rule-selector">
      <code class="${r.missing ? "missing" : ""}" data-selector>${escAttr(r.selector || "(선택 안 됨)")}</code>
      <button class="btn btn-sm" data-action="reselect" title="요소 다시 선택">다시 선택</button>
      <button class="btn btn-sm btn-icon" data-action="refresh" title="이 페이지에서 재추출">↻</button>
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
    <button class="btn btn-sm btn-ghost" data-action="xf-add">+ 변환 추가</button>

    <div class="rule-foot">
      <label><input type="checkbox" data-field="trim" ${r.trim ? "checked" : ""}/> 앞뒤 공백 제거</label>
      <label><input type="checkbox" data-field="enabled" ${r.enabled ? "checked" : ""}/> 조합에 포함</label>
    </div>

    <div class="rule-result" data-result="${r.id}"></div>
  </div>`;
}

function renderRules() {
  rulesEl.innerHTML = state.rules.map((r, i) => ruleCardHTML(r, i + 1)).join("");
  emptyHint.classList.toggle("hidden", state.rules.length > 0);
  recompute();
}

function renderCombineControls() {
  $("#separator").value = state.combine.separator;
  $("#custom-sep").value = state.combine.customSep || "";
  $("#custom-sep").classList.toggle("hidden", state.combine.separator !== "custom");
  $("#template").value = state.combine.template || "";
  const isTpl = state.combine.mode === "template";
  $("#join-opts").classList.toggle("hidden", isTpl);
  $("#template-opts").classList.toggle("hidden", !isTpl);
  $$(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.combine.mode));
}
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---- 요소 선택 / 추출 (콘텐츠 스크립트 연동) -----------------------------
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function injectable(url) {
  return /^(https?|file):/.test(url || "");
}

async function ensurePicker(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["src/content/picker.css"] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content/picker.js"] });
}

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

async function refreshAll() {
  for (const r of state.rules) await refreshRule(r);
  renderRules();
  toast("현재 페이지에서 재추출했어요");
}

// 콘텐츠 스크립트로부터의 메시지 수신
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
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
    toast("요소를 가져왔어요 ✓");
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

$("#btn-refresh").addEventListener("click", refreshAll);

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
  toast("복사됨 ✓");
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
  toast("프리셋 저장됨 ✓");
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

// ---- 사이트 & 단축키 설정 -----------------------------------------------
async function loadShortcutSettings() {
  const { allowedPatterns } = await chrome.storage.local.get("allowedPatterns");
  const patterns = Array.isArray(allowedPatterns) ? allowedPatterns : DEFAULT_PATTERNS;
  $("#allowed-patterns").value = patterns.join("\n");
  if (!Array.isArray(allowedPatterns)) {
    chrome.storage.local.set({ allowedPatterns: DEFAULT_PATTERNS }); // 최초 기본값 저장
  }
  try {
    const cmds = await chrome.commands.getAll();
    const c = cmds.find((x) => x.name === "copy-combined");
    $("#shortcut-key").textContent = c && c.shortcut ? c.shortcut : "(미설정)";
  } catch (_) {
    $("#shortcut-key").textContent = "단축키";
  }
}

let patTimer = null;
$("#allowed-patterns").addEventListener("input", (e) => {
  const text = e.target.value;
  clearTimeout(patTimer);
  patTimer = setTimeout(() => {
    chrome.storage.local.set({ allowedPatterns: parsePatterns(text) });
  }, 300);
});

$("#btn-change-shortcut").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
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

// ---- 초기화 --------------------------------------------------------------
(async function init() {
  await loadState();
  renderCombineControls();
  renderRules();
  renderPresets();
  loadShortcutSettings();
})();
