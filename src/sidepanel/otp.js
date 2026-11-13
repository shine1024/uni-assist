// 사이드 패널: OTP 인증기 화면
//
// 이 화면은 비밀키를 갖고 있지 않다. 목록·코드 계산·복사·QR 해석은 서비스 워커(background/otp.js)가 하고,
// 여기서는 발급자·계정·현재 코드·남은 시간만 받아 그린다.
// 예외: 직접 입력한 비밀키(저장 즉시 입력칸을 비움), 「비밀키 보기」 응답(30초 뒤 화면에서 지움).
import { icon } from "./icons.js";
import { K_OTP_SETTINGS } from "../lib/otp-store.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const send = (msg) =>
  chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, code: "NO_WORKER", message: e.message }));

const REVEAL_MS = 30000;

let toast = () => {};
let showView = () => {};
let visible = false;
let st = null; // 마지막 OTP_STATUS
let items = [];
let nextRefreshAt = 0;
let timer = null;
let searchText = "";
let editingId = null;
let revealTimer = null;
let lockMode = "unlock"; // "unlock" | "migrate"
let busy = false;

// ---- 상태 / 잠금 -------------------------------------------------------------
async function refresh() {
  st = await send({ type: "OTP_STATUS" });
  if (!st || !st.ok) return;
  renderSettings();
  if (!visible) return;
  const locked = !st.unlocked;
  $("#otp-lock").classList.toggle("hidden", !locked);
  $("#otp-head-actions").classList.toggle("hidden", locked);
  $("#otp-main").classList.toggle("hidden", locked || !!editingId);
  $("#otp-detail").classList.toggle("hidden", locked || !editingId);
  if (locked) {
    editingId = null;
    clearReveal();
    renderLock();
    items = [];
    $("#otp-list").innerHTML = "";
    return;
  }
  await loadList();
}

function renderLock() {
  const migrate = lockMode === "migrate";
  $("#otp-pw-old").classList.toggle("hidden", !migrate);
  $("#btn-otp-goto-login").classList.toggle("hidden", st.masterReady);
  $("#otp-pw-fields").classList.toggle("hidden", !st.masterReady);
  $("#btn-otp-unlock").classList.toggle("hidden", !st.masterReady);
  if (!st.masterReady) {
    $("#otp-lock-title").textContent = "마스터 비밀번호가 필요해요";
    $("#otp-lock-hint").innerHTML =
      "OTP 인증기는 <b>자동 로그인과 같은 마스터 비밀번호</b>로 암호화합니다. 먼저 자동 로그인 화면에서 마스터 비밀번호를 설정하세요.";
  } else if (migrate) {
    $("#otp-lock-title").textContent = "마스터 비밀번호가 바뀌었어요";
    $("#otp-lock-hint").innerHTML =
      "이 PC 의 OTP 는 <b>이전 마스터 비밀번호</b>로 잠겨 있어요(다른 PC 에서 바꾼 경우). " +
      "이전 비밀번호와 현재 비밀번호를 입력하면 현재 비밀번호로 옮깁니다.";
    $("#otp-pw").placeholder = "현재 마스터 비밀번호";
    $("#btn-otp-unlock").textContent = "옮기고 잠금 해제";
  } else {
    $("#otp-lock-title").textContent = st.initialized ? "잠금 해제" : "OTP 인증기 시작";
    $("#otp-lock-hint").innerHTML = st.initialized
      ? `자동 로그인과 같은 마스터 비밀번호를 입력하세요. <b>${st.settings.autoLockMinutes}분</b> 뒤 자동으로 잠깁니다.`
      : "자동 로그인의 마스터 비밀번호를 입력하면 OTP 전용 암호화 키를 만들고 시작합니다.";
    $("#otp-pw").placeholder = "마스터 비밀번호";
    $("#btn-otp-unlock").textContent = st.initialized ? "잠금 해제" : "시작";
  }
}

function lockError(msg) {
  $("#otp-lock-error").textContent = msg || "";
  $("#otp-lock-error").classList.toggle("hidden", !msg);
}

async function doUnlock() {
  if (busy) return;
  const pw = $("#otp-pw").value;
  const old = $("#otp-pw-old").value;
  if (!pw || (lockMode === "migrate" && !old)) return lockError("비밀번호를 입력하세요");
  busy = true;
  $("#btn-otp-unlock").disabled = true;
  lockError("확인 중…");
  const r =
    lockMode === "migrate"
      ? await send({ type: "OTP_MIGRATE_MASTER", oldPassword: old, password: pw })
      : await send({ type: "OTP_UNLOCK", password: pw });
  busy = false;
  $("#btn-otp-unlock").disabled = false;
  if (r && r.ok) {
    $("#otp-pw").value = "";
    $("#otp-pw-old").value = "";
    lockMode = "unlock";
    lockError("");
    toast(r.created ? "OTP 인증기를 시작했어요" : "잠금 해제");
    return refresh();
  }
  if (r && r.code === "MASTER_CHANGED") {
    lockMode = "migrate";
    // 방금 입력한 비밀번호가 이전 것인지 현재 것인지 알 수 없으니 둘 다 비우고 다시 받는다
    $("#otp-pw").value = "";
    renderLock();
    $("#otp-pw-old").focus();
  }
  lockError((r && r.message) || "잠금 해제 실패");
}

async function lockNow() {
  await send({ type: "OTP_LOCK" });
  toast("OTP 인증기를 잠갔어요");
  refresh();
}

// ---- 목록 --------------------------------------------------------------------
async function loadList() {
  const r = await send({ type: "OTP_LIST" });
  if (!r || !r.ok) {
    if (r && r.code === "LOCKED") return refresh();
    toast((r && r.message) || "목록을 읽지 못했어요");
    return;
  }
  items = r.items;
  const skew = Date.now() - r.now; // 패널·워커 시각 차이(같은 PC 라 거의 0)
  for (const it of items) if (it.validUntil) it.validUntil += skew;
  nextRefreshAt = Math.min(...items.filter((i) => !i.broken).map((i) => i.validUntil), Infinity);
  renderList();
}

function fmtCode(code) {
  if (!code) return "------";
  if (code.length === 6) return code.slice(0, 3) + " " + code.slice(3);
  if (code.length === 8) return code.slice(0, 4) + " " + code.slice(4);
  return code;
}

function filtered() {
  const q = searchText.trim().toLowerCase();
  if (!q) return items;
  return items.filter((i) => `${i.issuer || ""} ${i.account || ""}`.toLowerCase().includes(q));
}

function itemHTML(it) {
  if (it.broken) {
    return `<div class="otp-item broken" data-id="${esc(it.id)}">
      <div class="otp-who"><div class="otp-issuer">열 수 없는 항목</div>
      <div class="otp-account">다른 키로 암호화됐거나 손상됐어요</div></div>
      <button class="btn btn-icon btn-sm btn-danger" data-action="delete" title="삭제">${icon("trash")}</button></div>`;
  }
  const title = it.issuer || it.account;
  const sub = it.issuer ? it.account : "";
  return `<div class="otp-item" draggable="${searchText ? "false" : "true"}" data-id="${esc(it.id)}">
    <div class="otp-who">
      <div class="otp-issuer">${esc(title)}</div>
      ${sub ? `<div class="otp-account">${esc(sub)}</div>` : ""}
    </div>
    <button class="otp-num" data-action="copy" title="클릭하면 복사">
      <span class="real">${esc(fmtCode(it.code))}</span><span class="mask">${it.digits === 8 ? "•••• ••••" : "••• •••"}</span>
    </button>
    <span class="otp-sec"></span>
    <button class="btn btn-icon btn-sm" data-action="edit" title="수정">${icon("edit")}</button>
    <div class="otp-timer"><i></i></div>
  </div>`;
}

function renderList() {
  const list = filtered();
  const box = $("#otp-list");
  box.classList.toggle("masked", !!(st && st.settings && st.settings.maskCodes));
  box.innerHTML = list.map(itemHTML).join("");
  $("#otp-empty").classList.toggle("hidden", items.length > 0);
  $("#otp-search").classList.toggle("hidden", items.length < 4 && !searchText);
  tickTimers();
}

function tickTimers() {
  const now = Date.now();
  for (const el of $$(".otp-item[data-id]", $("#otp-list"))) {
    const it = items.find((x) => x.id === el.dataset.id);
    if (!it || it.broken) continue;
    const left = Math.max(0, Math.ceil((it.validUntil - now) / 1000));
    const soon = left <= 5;
    const bar = $(".otp-timer i", el);
    bar.style.width = `${Math.min(100, (left / it.period) * 100)}%`;
    bar.classList.toggle("soon", soon);
    $(".otp-num", el).classList.toggle("soon", soon);
    $(".otp-sec", el).textContent = `${left}s`;
  }
  if (st && st.expiresAt) {
    const ms = st.expiresAt - now;
    $("#otp-remain").textContent = ms > 0 ? `${Math.ceil(ms / 60000)}분` : "";
  }
}

async function onTick() {
  if (!visible || !st || !st.unlocked) return;
  if (st.expiresAt && Date.now() > st.expiresAt) return refresh();
  if (!editingId && Date.now() >= nextRefreshAt) await loadList();
  else tickTimers();
}

async function copyItem(id) {
  const r = await send({ type: "OTP_COPY", id });
  if (r && r.ok) {
    toast(r.cleared ? "복사됨 — 30초 뒤 클립보드에서 지워요" : "복사됨");
    st = await send({ type: "OTP_STATUS" }); // 잠금 시간 연장 반영
  } else if (r && r.code === "LOCKED") refresh();
  else toast((r && r.message) || "복사하지 못했어요");
}

// ---- 드래그로 순서 변경 --------------------------------------------------------
function bindDrag() {
  const box = $("#otp-list");
  let dragging = null;
  const clear = () => $$(".drop-before, .drop-after", box).forEach((x) => x.classList.remove("drop-before", "drop-after"));
  const target = (e) => {
    const el = e.target.closest(".otp-item[data-id]");
    if (!dragging || !el || el.dataset.id === dragging) return null;
    const r = el.getBoundingClientRect();
    return { el, before: e.clientY < r.top + r.height / 2 };
  };
  box.addEventListener("dragstart", (e) => {
    const el = e.target.closest(".otp-item[draggable=true]");
    if (!el) return;
    dragging = el.dataset.id;
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  box.addEventListener("dragover", (e) => {
    const t = target(e);
    if (!t) return;
    e.preventDefault();
    clear();
    t.el.classList.add(t.before ? "drop-before" : "drop-after");
  });
  box.addEventListener("drop", async (e) => {
    const t = target(e);
    clear();
    if (!t) return;
    e.preventDefault();
    const order = items.map((i) => i.id).filter((id) => id !== dragging);
    order.splice(order.indexOf(t.el.dataset.id) + (t.before ? 0 : 1), 0, dragging);
    items.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    renderList();
    const r = await send({ type: "OTP_REORDER", ids: order });
    if (!r || !r.ok) toast("순서를 저장하지 못했어요");
  });
  box.addEventListener("dragend", () => {
    dragging = null;
    clear();
    $$(".dragging", box).forEach((x) => x.classList.remove("dragging"));
  });
}

// ---- 추가 --------------------------------------------------------------------
function addError(msg) {
  $("#otp-add-error").textContent = msg || "";
  $("#otp-add-error").classList.toggle("hidden", !msg);
}

function openAdd(show = true) {
  $("#otp-add").classList.toggle("hidden", !show);
  if (!show) {
    showAddMode(null);
    addError("");
  }
}

function showAddMode(mode) {
  $("#otp-add-manual").classList.toggle("hidden", mode !== "manual");
  $("#otp-add-text").classList.toggle("hidden", mode !== "text");
  $$("#otp-add [data-add]").forEach((b) => b.classList.toggle("active", b.dataset.add === mode));
  if (mode !== "manual") wipeManual();
  if (mode === "manual") $("#otp-m-issuer").focus();
  if (mode === "text") $("#otp-text").focus();
}

function wipeManual() {
  ["#otp-m-issuer", "#otp-m-account", "#otp-m-secret"].forEach((s) => ($(s).value = ""));
}

async function saveManual() {
  addError("");
  const entry = {
    issuer: $("#otp-m-issuer").value,
    account: $("#otp-m-account").value,
    secret: $("#otp-m-secret").value,
    algorithm: $("#otp-m-alg").value,
    digits: Number($("#otp-m-digits").value),
    period: Number($("#otp-m-period").value),
  };
  const r = await send({ type: "OTP_ADD", entry });
  entry.secret = null;
  if (!r || !r.ok) return addError((r && r.message) || "저장하지 못했어요");
  wipeManual();
  openAdd(false);
  toast("추가했어요");
  loadList();
}

async function scanScreen() {
  addError("");
  const win = await chrome.windows.getCurrent().catch(() => null);
  const r = await send({ type: "OTP_SCAN_TAB", windowId: win ? win.id : undefined });
  handleStaged(r);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

async function scanImageFile(file) {
  if (!file || !/^image\//.test(file.type)) return addError("이미지 파일이 아니에요");
  if (file.size > 15 * 1024 * 1024) return addError("이미지가 너무 커요 (15MB 이하)");
  addError("");
  let dataUrl = await readFileAsDataUrl(file);
  const r = await send({ type: "OTP_SCAN_IMAGE", dataUrl });
  dataUrl = null;
  handleStaged(r);
}

async function readText() {
  addError("");
  const r = await send({ type: "OTP_PARSE_TEXT", text: $("#otp-text").value });
  if (r && r.ok) $("#otp-text").value = "";
  handleStaged(r);
}

// ---- 가져오기 미리보기 ---------------------------------------------------------
function handleStaged(r) {
  if (!r || !r.ok) {
    if (r && r.code === "LOCKED") return refresh();
    $("#otp-add").classList.remove("hidden");
    return addError((r && r.message) || "읽지 못했어요");
  }
  if (!r.items.length) {
    $("#otp-add").classList.remove("hidden");
    const why = r.skipped.map((s) => `${s.label}: ${s.reason}`).join(" / ");
    return addError("가져올 수 있는 계정이 없어요" + (why ? ` (${why})` : ""));
  }
  openAdd(false);
  const box = $("#otp-preview-list");
  box.innerHTML = r.items
    .map(
      (it) => `<label class="chk">
        <input type="checkbox" data-tmp="${esc(it.tmpId)}" ${it.duplicate ? "" : "checked"} />
        <span><b>${esc(it.issuer || it.account)}</b>${it.issuer && it.account ? ` <span class="muted">${esc(it.account)}</span>` : ""}
        ${it.duplicate ? '<span class="tag tag-off">이미 있음</span>' : ""}
        ${it.digits !== 6 || it.period !== 30 || it.algorithm !== "SHA1" ? `<span class="tag tag-off">${it.digits}자리 · ${it.period}초 · ${esc(it.algorithm)}</span>` : ""}</span>
      </label>`
    )
    .join("");
  $("#otp-preview-skipped").innerHTML = r.skipped.length
    ? "건너뜀: " + r.skipped.map((s) => `${esc(s.label)} — ${esc(s.reason)}`).join("<br />")
    : "";
  const batch = $("#otp-preview-batch");
  batch.classList.toggle("hidden", !r.batch);
  batch.textContent = r.batch ? `QR ${r.batch.index + 1} / ${r.batch.size}` : "";
  updatePreviewButton();
  $("#otp-preview").classList.remove("hidden");
}

function updatePreviewButton() {
  const n = $$("#otp-preview-list input:checked").length;
  $("#btn-otp-preview-ok").textContent = `${n}개 추가`;
  $("#btn-otp-preview-ok").disabled = n === 0;
}

async function confirmImport() {
  const tmpIds = $$("#otp-preview-list input:checked").map((x) => x.dataset.tmp);
  const r = await send({ type: "OTP_IMPORT_CONFIRM", tmpIds });
  $("#otp-preview").classList.add("hidden");
  $("#otp-preview-list").innerHTML = "";
  if (!r || !r.ok) return toast((r && r.message) || "가져오지 못했어요");
  toast(`${r.added}개 추가했어요`);
  loadList();
}

async function cancelImport() {
  await send({ type: "OTP_IMPORT_CANCEL" });
  $("#otp-preview").classList.add("hidden");
  $("#otp-preview-list").innerHTML = "";
}

// ---- 수정 / 비밀키 보기 / 삭제 -------------------------------------------------
function clearReveal() {
  clearTimeout(revealTimer);
  revealTimer = null;
  const box = $("#otp-reveal-box");
  if (box) {
    box.innerHTML = "";
    box.classList.add("hidden");
  }
}

function openDetail(id) {
  const it = items.find((x) => x.id === id);
  if (!it) return;
  editingId = id;
  const d = $("#otp-detail");
  d.innerHTML = `
    <div class="card-head">
      <h2><button class="btn btn-icon btn-sm" data-action="back" title="목록으로">${icon("back")}</button>OTP 수정</h2>
    </div>
    <div class="field-col">
      <label>서비스 이름</label>
      <input id="otp-e-issuer" autocomplete="off" spellcheck="false" value="${esc(it.issuer)}" />
      <label>계정</label>
      <input id="otp-e-account" autocomplete="off" spellcheck="false" value="${esc(it.account)}" />
    </div>
    <p class="err hidden" id="otp-e-error"></p>
    <div class="result-actions">
      <button class="btn btn-danger btn-sm" data-action="delete">${icon("trash")}삭제</button>
      <button class="btn btn-primary btn-sm" data-action="save">저장</button>
    </div>
    <details class="token-box" id="otp-reveal">
      <summary>비밀키 보기 — 다른 앱으로 옮길 때</summary>
      <p class="muted hint-text">잠금이 풀려 있어도 <b>마스터 비밀번호를 다시</b> 입력해야 합니다. 30초 뒤 화면에서 지웁니다.</p>
      <div class="token-row">
        <input id="otp-reveal-pw" type="password" autocomplete="off" placeholder="마스터 비밀번호" />
        <button class="btn btn-ghost btn-sm" data-action="reveal">${icon("eye")}보기</button>
      </div>
      <div class="otp-secret-box hidden" id="otp-reveal-box"></div>
    </details>`;
  $("#otp-main").classList.add("hidden");
  d.classList.remove("hidden");
  $("#otp-e-issuer").focus();
}

function closeDetail() {
  clearReveal();
  editingId = null;
  $("#otp-detail").classList.add("hidden");
  $("#otp-detail").innerHTML = "";
  $("#otp-main").classList.remove("hidden");
  if (visible) loadList();
}

function detailError(msg) {
  const el = $("#otp-e-error");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
}

async function onDetailClick(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn || !editingId) return;
  const id = editingId;
  switch (btn.dataset.action) {
    case "back":
      return closeDetail();
    case "save": {
      const r = await send({
        type: "OTP_UPDATE",
        id,
        patch: { issuer: $("#otp-e-issuer").value, account: $("#otp-e-account").value },
      });
      if (!r || !r.ok) return detailError((r && r.message) || "저장하지 못했어요");
      toast("저장했어요");
      return closeDetail();
    }
    case "delete":
      return deleteItem(id, true);
    case "reveal": {
      const pwEl = $("#otp-reveal-pw");
      btn.disabled = true;
      const r = await send({ type: "OTP_REVEAL", id, password: pwEl.value });
      btn.disabled = false;
      pwEl.value = "";
      if (!r || !r.ok) return detailError((r && r.message) || "확인하지 못했어요");
      detailError("");
      const box = $("#otp-reveal-box");
      box.innerHTML = `<code>${esc(r.secret)}</code><code>${esc(r.uri)}</code>`;
      box.classList.remove("hidden");
      clearTimeout(revealTimer);
      revealTimer = setTimeout(clearReveal, REVEAL_MS);
      return;
    }
  }
}

async function deleteItem(id, fromDetail) {
  const it = items.find((x) => x.id === id);
  const name = it && !it.broken ? it.issuer || it.account : "이 항목";
  const ok = confirm(
    `'${name}' OTP 를 삭제할까요?\n\n삭제하면 되돌릴 수 없어요. 다른 기기(폰 등)에 같은 OTP 가 없다면 ` +
      "그 서비스에 로그인하지 못할 수 있으니, 먼저 서비스에서 2단계 인증을 바꾸거나 복구 코드를 확인하세요."
  );
  if (!ok) return;
  const r = await send({ type: "OTP_DELETE", id });
  if (!r || !r.ok) return toast((r && r.message) || "삭제하지 못했어요");
  toast("삭제했어요");
  if (fromDetail) closeDetail();
  else loadList();
}

// ---- 설정 카드 (설정 화면) -------------------------------------------------------
function renderSettings() {
  if (!st || !st.ok) return;
  const s = st.settings;
  $("#otp-auto-lock").value = String(s.autoLockMinutes);
  $("#otp-mask").checked = s.maskCodes;
  $("#otp-clear-clip").checked = s.clearClipboard;
  const ms = st.expiresAt - Date.now();
  $("#otp-sec-status").textContent = !st.initialized
    ? "미설정"
    : st.unlocked
      ? `해제됨 · ${Math.max(1, Math.ceil(ms / 60000))}분 남음`
      : "잠김";
}

async function saveSetting(patch) {
  const { [K_OTP_SETTINGS]: cur } = await chrome.storage.sync.get(K_OTP_SETTINGS);
  await chrome.storage.sync.set({ [K_OTP_SETTINGS]: { ...(cur || {}), ...patch } });
  toast("OTP 설정을 바꿨어요");
  refresh();
}

// ---- 붙여넣기 (Ctrl+V 로 QR 이미지·주소) -----------------------------------------
async function onPaste(e) {
  if (!visible || !st || !st.unlocked || editingId) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return; // 입력칸에 붙여넣는 건 그대로 둔다
  const dt = e.clipboardData;
  if (!dt) return;
  const file = Array.from(dt.files || []).find((f) => /^image\//.test(f.type));
  if (file) {
    e.preventDefault();
    toast("붙여넣은 이미지에서 QR 을 읽어요");
    return scanImageFile(file);
  }
  const text = dt.getData("text/plain");
  if (/otpauth(-migration)?:\/\//i.test(text || "")) {
    e.preventDefault();
    const r = await send({ type: "OTP_PARSE_TEXT", text });
    handleStaged(r);
  }
}

// ---- 초기화 --------------------------------------------------------------------
export function initOtpUI(deps) {
  toast = deps.toast;
  showView = deps.showView;

  $("#btn-otp-unlock").addEventListener("click", doUnlock);
  ["#otp-pw", "#otp-pw-old"].forEach((s) =>
    $(s).addEventListener("keydown", (e) => e.key === "Enter" && doUnlock())
  );
  $("#btn-otp-goto-login").addEventListener("click", () => showView("login"));
  $("#btn-otp-lock").addEventListener("click", lockNow);
  $("#btn-otp-add").addEventListener("click", () => openAdd($("#otp-add").classList.contains("hidden")));
  $("#btn-otp-add-close").addEventListener("click", () => openAdd(false));
  $("#otp-add").addEventListener("click", (e) => {
    const b = e.target.closest("[data-add]");
    if (!b) return;
    const mode = b.dataset.add;
    if (mode === "scan") return scanScreen();
    if (mode === "image") return $("#otp-image-file").click();
    showAddMode(mode);
  });
  $("#otp-image-file").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (f) scanImageFile(f);
  });
  $("#btn-otp-m-save").addEventListener("click", saveManual);
  $("#otp-m-secret").addEventListener("keydown", (e) => e.key === "Enter" && saveManual());
  $("#btn-otp-text-read").addEventListener("click", readText);
  $("#otp-preview-list").addEventListener("change", updatePreviewButton);
  $("#btn-otp-preview-ok").addEventListener("click", confirmImport);
  $("#btn-otp-preview-cancel").addEventListener("click", cancelImport);
  $("#otp-search").addEventListener("input", (e) => {
    searchText = e.target.value;
    renderList();
  });
  $("#otp-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    const row = e.target.closest(".otp-item[data-id]");
    if (!btn || !row) return;
    if (btn.dataset.action === "copy") copyItem(row.dataset.id);
    else if (btn.dataset.action === "edit") openDetail(row.dataset.id);
    else if (btn.dataset.action === "delete") deleteItem(row.dataset.id, false);
  });
  bindDrag();
  $("#otp-detail").addEventListener("click", onDetailClick);
  $("#otp-detail").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.target.id === "otp-reveal-pw") $('#otp-detail [data-action="reveal"]').click();
    else if (e.target.id === "otp-e-issuer" || e.target.id === "otp-e-account") $('#otp-detail [data-action="save"]').click();
  });
  document.addEventListener("paste", onPaste);

  $("#otp-auto-lock").addEventListener("change", (e) => saveSetting({ autoLockMinutes: Number(e.target.value) }));
  $("#otp-mask").addEventListener("change", (e) => saveSetting({ maskCodes: e.target.checked }));
  $("#otp-clear-clip").addEventListener("change", (e) => saveSetting({ clearClipboard: e.target.checked }));

  // 잠금·OTP 데이터가 바뀌면 다시 그린다 (다른 화면에서 잠갔거나 백업을 가져온 경우)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && "ua_otp_session" in changes) refresh();
    if (area === "sync" && K_OTP_SETTINGS in changes) refresh();
  });

  refresh();
}

export function onOtpShown(name) {
  const was = visible;
  visible = name === "otp";
  clearInterval(timer);
  if (visible) {
    if (!was) lockMode = "unlock";
    timer = setInterval(onTick, 1000);
    refresh();
  } else {
    // 다른 화면으로 나가면 코드·비밀키를 화면에 남기지 않는다
    if (editingId) closeDetail();
    clearReveal();
    wipeManual();
    items = [];
    $("#otp-list").innerHTML = "";
    if (name === "settings") refresh();
  }
}
