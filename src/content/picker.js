// 콘텐츠 스크립트 — 페이지에 주입되어 요소 선택/텍스트 추출을 담당한다.
// 사이드 패널이 chrome.scripting.executeScript 로 필요할 때 주입한다.
// 중복 주입되어도 안전하도록 가드한다(리스너 1회만 등록).

(() => {
  if (window.__uaPickerLoaded) return;
  window.__uaPickerLoaded = true;

  let picking = false;
  let pickRuleId = null;
  let overlay = null;
  let label = null;
  let hint = null;
  let currentEl = null;

  // ---- 셀렉터 생성 -------------------------------------------------------
  function esc(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, "\\$&");
  }

  function buildSelector(el) {
    if (!(el instanceof Element)) return null;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id) {
        parts.unshift("#" + esc(node.id));
        break; // id를 고유 앵커로 사용
      }
      let sel = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(
          (c) => c.tagName === node.tagName
        );
        if (sameTag.length > 1) {
          sel += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
        }
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  // ---- 텍스트 추출 -------------------------------------------------------
  function isFormField(el) {
    return el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  }

  // source: innerText | textContent | value | attr
  function extractValue(el, source, attrName) {
    if (!el) return "";
    switch (source) {
      case "value":
        if (el.tagName === "SELECT") {
          return Array.from(el.selectedOptions || [])
            .map((o) => o.textContent)
            .join(", ");
        }
        return el.value != null ? String(el.value) : "";
      case "attr":
        return attrName ? el.getAttribute(attrName) || "" : "";
      case "textContent":
        return el.textContent || "";
      case "innerText":
      default:
        return el.innerText != null ? el.innerText : el.textContent || "";
    }
  }

  // 셀렉터로 요소를 찾되, 같은 셀렉터에 여러 개가 매칭되면 index로 구분
  function resolve(selector, index) {
    let list;
    try {
      list = document.querySelectorAll(selector);
    } catch (e) {
      return null;
    }
    if (!list.length) return null;
    if (typeof index === "number" && list[index]) return list[index];
    return list[0];
  }

  // ---- 선택 모드 UI ------------------------------------------------------
  function ensureUI() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "__ua-overlay";
    label = document.createElement("div");
    label.className = "__ua-label";
    hint = document.createElement("div");
    hint.className = "__ua-hint";
    hint.textContent = "요소를 클릭해 선택하세요 · ESC 취소";
    document.documentElement.append(overlay, label, hint);
  }

  function removeUI() {
    [overlay, label, hint].forEach((n) => n && n.remove());
    overlay = label = hint = null;
  }

  function moveOverlay(el) {
    if (!el || !overlay) return;
    const r = el.getBoundingClientRect();
    overlay.style.top = `${r.top}px`;
    overlay.style.left = `${r.left}px`;
    overlay.style.width = `${r.width}px`;
    overlay.style.height = `${r.height}px`;
    const sel = buildSelector(el);
    label.textContent = sel || el.tagName.toLowerCase();
    // 라벨 위치: 요소 위쪽, 화면 벗어나면 아래쪽
    const ly = r.top - 24 < 0 ? r.bottom + 4 : r.top - 24;
    label.style.top = `${Math.max(2, ly)}px`;
    label.style.left = `${Math.max(2, r.left)}px`;
  }

  function onMove(e) {
    if (!picking) return;
    const el = e.target;
    if (el === overlay || el === label || el === hint) return;
    currentEl = el;
    moveOverlay(el);
  }

  function onClick(e) {
    if (!picking) return;
    e.preventDefault();
    e.stopPropagation();
    const el = currentEl || e.target;
    finishPick(el);
  }

  function onKey(e) {
    if (!picking) return;
    if (e.key === "Escape") {
      e.preventDefault();
      cancelPick();
    }
  }

  function startPick(ruleId) {
    pickRuleId = ruleId;
    picking = true;
    ensureUI();
    document.documentElement.classList.add("__ua-picking");
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  }

  function stopPickListeners() {
    picking = false;
    document.documentElement.classList.remove("__ua-picking");
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    removeUI();
  }

  function cancelPick() {
    const id = pickRuleId;
    stopPickListeners();
    chrome.runtime.sendMessage({ type: "PICK_CANCELLED", ruleId: id });
  }

  function finishPick(el) {
    const id = pickRuleId;
    stopPickListeners();
    const selector = buildSelector(el);
    let index = 0;
    try {
      const list = document.querySelectorAll(selector);
      index = Array.from(list).indexOf(el);
      if (index < 0) index = 0;
    } catch (_) {}
    const source = isFormField(el) ? "value" : "innerText";
    chrome.runtime.sendMessage({
      type: "ELEMENT_PICKED",
      ruleId: id,
      selector,
      index,
      source,
      tag: el.tagName.toLowerCase(),
      rawText: extractValue(el, source),
    });
  }

  // ---- 페이지 토스트 (단축키 복사 등 피드백) -----------------------------
  let pageToast = null;
  let pageToastTimer = null;
  function showPageToast(text, kind) {
    if (!pageToast) {
      pageToast = document.createElement("div");
      pageToast.className = "__ua-toast";
      document.documentElement.appendChild(pageToast);
    }
    pageToast.textContent = text;
    pageToast.classList.toggle("error", kind === "error");
    // reflow 후 show (애니메이션)
    void pageToast.offsetWidth;
    pageToast.classList.add("show");
    clearTimeout(pageToastTimer);
    pageToastTimer = setTimeout(() => pageToast && pageToast.classList.remove("show"), 1500);
  }

  // ---- 메시지 라우팅 -----------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case "PING":
        sendResponse({ ok: true });
        return; // 동기 응답
      case "START_PICK":
        startPick(msg.ruleId);
        sendResponse({ ok: true });
        return;
      case "CANCEL_PICK":
        if (picking) cancelPick();
        sendResponse({ ok: true });
        return;
      case "EXTRACT": {
        const el = resolve(msg.selector, msg.index);
        sendResponse({
          ok: !!el,
          rawText: el ? extractValue(el, msg.source, msg.attrName) : "",
          found: !!el,
        });
        return;
      }
      case "EXTRACT_ALL": {
        const values = {};
        const missing = [];
        (msg.rules || []).forEach((d) => {
          const el = resolve(d.selector, d.index);
          if (el) {
            values[d.id] = extractValue(el, d.source, d.attrName);
          } else {
            values[d.id] = "";
            missing.push(d.id);
          }
        });
        sendResponse({ ok: true, values, missing });
        return;
      }
      case "TOAST":
        showPageToast(msg.text, msg.kind);
        sendResponse({ ok: true });
        return;
      default:
        return;
    }
  });
})();
