// content.js - Injected into every page
// Exposes window.__agy_execute for background.js to call

window.__agy_execute = async function(action, params = {}) {
  try {
    switch (action) {
      case "getContext": return getContext();
      case "click":      return clickElement(params);
      case "type":       return typeText(params);
      case "scroll":     return scrollPage(params);
      case "getElement": return getElement(params);
      case "getArticleText": return getArticleText();
      case "getTranscript": return await getYoutubeTranscript();
      case "startPicker": return await startElementPicker();
      default: return { error: "Unknown action: " + action };
    }
  } catch(e) {
    return { error: e.message };
  }
};

// ── Basic Context ──────────────────────────────────────────────────────────
function getContext() {
  const selection = window.getSelection()?.toString()?.trim() || "";
  const text = document.body?.innerText?.slice(0, 50000) || "";
  const headings = [...document.querySelectorAll("h1,h2,h3")]
    .map(h => ({ level: h.tagName, text: h.innerText.trim() })).slice(0, 50);
  const links = [...document.querySelectorAll("a[href]")]
    .map(a => ({ text: a.innerText.trim().slice(0,80), href: a.href }))
    .filter(l => l.text && l.href.startsWith("http")).slice(0, 30);
  const forms = [...document.querySelectorAll("form")]
    .map(f => ({
      id: f.id, action: f.action,
      inputs: [...f.querySelectorAll("input,textarea,select")]
        .map(i => ({ type: i.type, name: i.name, id: i.id, placeholder: i.placeholder }))
    })).slice(0, 10);
  const meta = {};
  document.querySelectorAll("meta[name],[property]").forEach(m => {
    const k = m.getAttribute("name") || m.getAttribute("property");
    if (k) meta[k] = m.getAttribute("content");
  });
  return {
    url: location.href,
    title: document.title,
    selectedText: selection,
    text: text,
    headings,
    links,
    forms,
    meta,
    timestamp: Date.now()
  };
}

// ── Clean Article Content ──────────────────────────────────────────────────
function getArticleText() {
  const clone = document.body.cloneNode(true);
  const removeSelectors = [
    "script", "style", "noscript", "iframe", "svg", "nav", "footer", "header",
    "aside", "[role='navigation']", "[role='banner']", ".ad", ".ads", "#comments"
  ];
  removeSelectors.forEach(sel => {
    clone.querySelectorAll(sel).forEach(el => el.remove());
  });
  const text = (clone.innerText || "").replace(/\n\s*\n+/g, "\n\n").trim().slice(0, 25000);
  return {
    title: document.title,
    url: location.href,
    text,
    length: text.length
  };
}

// ── DOM Interactions ───────────────────────────────────────────────────────
function clickElement({ selector, text }) {
  let el = null;
  if (selector) {
    el = document.querySelector(selector);
  } else if (text) {
    const all = document.querySelectorAll("button,a,[role=button],[role=link],input[type=submit]");
    el = [...all].find(e => e.innerText?.trim().toLowerCase().includes(text.toLowerCase()));
  }
  if (!el) return { error: `Element not found: ${selector || text}` };
  el.scrollIntoView({ block: "center" });
  el.click();
  return { message: `Clicked: ${el.tagName} "${el.innerText?.trim().slice(0,50)}"` };
}

function typeText({ selector, text, clearFirst }) {
  let el = selector ? document.querySelector(selector) : document.activeElement;
  if (!el || !["INPUT","TEXTAREA"].includes(el.tagName)) {
    el = document.querySelector("input:not([type=hidden]),textarea");
  }
  if (!el) return { error: "No input element found" };
  el.focus();
  if (clearFirst) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); }
  el.value += text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { message: `Typed into ${el.tagName}#${el.id || el.name}` };
}

function scrollPage({ direction, selector, pixels }) {
  if (selector) {
    const el = document.querySelector(selector);
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); return { message: "Scrolled to element" }; }
  }
  const px = pixels || 400;
  switch(direction) {
    case "top":    window.scrollTo({ top: 0, behavior: "smooth" }); break;
    case "bottom": window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); break;
    case "up":     window.scrollBy({ top: -px, behavior: "smooth" }); break;
    default:       window.scrollBy({ top: px, behavior: "smooth" }); break;
  }
  return { message: `Scrolled ${direction || "down"} ${px}px` };
}

function getElement({ selector }) {
  const el = document.querySelector(selector);
  if (!el) return { error: `Not found: ${selector}` };
  const rect = el.getBoundingClientRect();
  return {
    tag: el.tagName,
    id: el.id,
    className: el.className,
    text: el.innerText?.trim().slice(0, 500),
    value: el.value,
    href: el.href,
    src: el.src,
    attributes: [...el.attributes].reduce((a,attr) => { a[attr.name]=attr.value; return a; }, {}),
    boundingBox: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
  };
}

// ── Unique CSS Selector Generator ──────────────────────────────────────────
function getUniqueSelector(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return "";
  if (el.id) return `#${CSS.escape(el.id)}`;
  
  if (el.getAttribute("data-testid")) {
    return `${el.tagName.toLowerCase()}[data-testid="${CSS.escape(el.getAttribute("data-testid"))}"]`;
  }
  if (el.name) {
    return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
  }
  if (el.getAttribute("aria-label")) {
    return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(el.getAttribute("aria-label"))}"]`;
  }

  let path = [];
  let curr = el;
  while (curr && curr.nodeType === Node.ELEMENT_NODE && curr !== document.body && curr !== document.documentElement) {
    let sel = curr.tagName.toLowerCase();
    if (curr.id) {
      sel = `#${CSS.escape(curr.id)}`;
      path.unshift(sel);
      break;
    }
    const classes = [...curr.classList].filter(c => !c.startsWith("__agy_") && c.length < 30);
    if (classes.length > 0) {
      sel += `.${classes.slice(0, 2).map(c => CSS.escape(c)).join(".")}`;
    }
    let sibling = curr;
    let nth = 1;
    while ((sibling = sibling.previousElementSibling)) {
      if (sibling.tagName === curr.tagName) nth++;
    }
    if (nth > 1) sel += `:nth-of-type(${nth})`;
    path.unshift(sel);
    curr = curr.parentElement;
  }
  return path.join(" > ");
}

// ── Interactive Element Picker ─────────────────────────────────────────────
let activePicker = null;

function startElementPicker() {
  if (activePicker) activePicker.cleanup();

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.id = "__agy_inspector_overlay";
    overlay.style.cssText = `
      position: fixed;
      pointer-events: none;
      border: 2px solid #6366f1;
      background: rgba(99, 102, 241, 0.2);
      border-radius: 4px;
      z-index: 2147483647;
      transition: all 0.05s ease-out;
      box-shadow: 0 0 12px rgba(99, 102, 241, 0.5);
      display: none;
    `;

    const badge = document.createElement("div");
    badge.id = "__agy_inspector_badge";
    badge.style.cssText = `
      position: fixed;
      background: #111622;
      color: #f1f5f9;
      border: 1px solid #6366f1;
      padding: 4px 8px;
      font-size: 11px;
      font-family: monospace;
      border-radius: 4px;
      z-index: 2147483647;
      pointer-events: none;
      display: none;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    `;

    document.documentElement.appendChild(overlay);
    document.documentElement.appendChild(badge);

    let currentTarget = null;

    function onMouseMove(e) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === overlay || el === badge) return;
      currentTarget = el;
      const rect = el.getBoundingClientRect();

      overlay.style.display = "block";
      overlay.style.top = `${rect.top}px`;
      overlay.style.left = `${rect.left}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;

      const selector = getUniqueSelector(el);
      badge.textContent = selector.length > 50 ? selector.slice(0, 50) + "..." : selector;
      badge.style.display = "block";
      badge.style.top = `${Math.max(4, rect.top - 28)}px`;
      badge.style.left = `${Math.max(4, rect.left)}px`;
    }

    function onClick(e) {
      e.preventDefault();
      e.stopPropagation();
      cleanup();

      if (!currentTarget) return resolve({ cancelled: true });

      const selector = getUniqueSelector(currentTarget);
      const details = {
        selector,
        tag: currentTarget.tagName.toLowerCase(),
        id: currentTarget.id || null,
        className: currentTarget.className || null,
        text: currentTarget.innerText?.trim()?.slice(0, 100) || "",
        value: currentTarget.value || null
      };

      try {
        navigator.clipboard?.writeText(selector);
      } catch {}

      resolve(details);
    }

    function onKeyDown(e) {
      if (e.key === "Escape") {
        cleanup();
        resolve({ cancelled: true });
      }
    }

    function cleanup() {
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      badge.remove();
      activePicker = null;
    }

    activePicker = { cleanup };
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKeyDown, true);
  });
}

// ── YouTube Transcript Extractor ───────────────────────────────────────────
async function getYoutubeTranscript() {
  if (!location.hostname.includes("youtube.com") || !location.pathname.includes("/watch")) {
    return { error: "Not a YouTube video page. Open any YouTube video tab." };
  }

  function extractCues() {
    const segments = document.querySelectorAll("ytd-transcript-segment-renderer");
    if (!segments || segments.length === 0) return null;
    const cues = [];
    segments.forEach(s => {
      const time = s.querySelector(".segment-timestamp, [class*='timestamp']")?.innerText?.trim();
      const text = s.querySelector(".segment-text, [class*='segment-text']")?.innerText?.trim();
      if (text) cues.push({ time: time || "", text });
    });
    return cues;
  }

  let cues = extractCues();
  if (cues && cues.length > 0) {
    const fullText = cues.map(c => `[${c.time}] ${c.text}`).join("\n");
    return { videoTitle: document.title, totalCues: cues.length, cues, fullText };
  }

  // Expand description to reveal transcript button
  const expandBtn = document.querySelector("#expand, tp-yt-paper-button#expand, #description #expand");
  if (expandBtn) expandBtn.click();

  await new Promise(r => setTimeout(r, 600));

  const transcriptBtn = [...document.querySelectorAll("button, ytd-button-renderer")].find(b =>
    b.innerText?.includes("Показать текст видео") ||
    b.innerText?.toLowerCase().includes("transcript") ||
    b.getAttribute("aria-label")?.includes("Показать текст видео")
  );

  if (transcriptBtn) {
    transcriptBtn.click();
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 400));
      cues = extractCues();
      if (cues && cues.length > 0) break;
    }
  }

  if (!cues || cues.length === 0) {
    return { error: "Could not locate transcript. Video might not have subtitles/transcript available." };
  }

  const fullText = cues.map(c => `[${c.time}] ${c.text}`).join("\n");
  return { videoTitle: document.title, totalCues: cues.length, cues, fullText };
}
