// content.js - Injected into every page
// Exposes window.__agy_execute for background.js to call

window.__agy_execute = function(action, params) {
  try {
    switch (action) {
      case "getContext": return getContext();
      case "click":     return clickElement(params);
      case "type":      return typeText(params);
      case "scroll":    return scrollPage(params);
      case "getElement": return getElement(params);
      default: return { error: "Unknown action: " + action };
    }
  } catch(e) {
    return { error: e.message };
  }
};

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
