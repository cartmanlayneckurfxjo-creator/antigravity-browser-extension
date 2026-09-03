// ── Utility: Escape HTML ───────────────────────────────────────────────────
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ── DOM Elements ───────────────────────────────────────────────────────────
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const pageTitle = document.getElementById("pageTitle");
const pageUrl = document.getElementById("pageUrl");

const logContainer = document.getElementById("log");

// ── KeepAlive Port with Service Worker ─────────────────────────────────────
let keepAlivePort = null;
function setupKeepAlive() {
  try {
    keepAlivePort = chrome.runtime.connect({ name: "sidepanel-keepalive" });
    keepAlivePort.onDisconnect.addListener(() => {
      setTimeout(setupKeepAlive, 1000);
    });
  } catch (e) {
    console.warn("KeepAlive error:", e);
  }
}
setupKeepAlive();

// ── Status & Page Context ──────────────────────────────────────────────────
function setStatus(status) {
  statusDot.className = "status-dot " + status;
  const labels = {
    connected: "Antigravity IDE Ready",
    disconnected: "MCP Offline",
    error: "WS Error"
  };
  statusText.textContent = labels[status] || status;
}

async function updatePageInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) {
      pageUrl.textContent = tab.url || "—";
      pageTitle.textContent = tab.title || "No page title";
    }
  } catch {}
}

// ── Content Script Auto-Injection ──────────────────────────────────────────
async function ensureContentScript(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => typeof window.__agy_execute === "function",
    });
    if (!results?.[0]?.result) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
    }
  } catch (e) {
    console.warn("Could not inject content script:", e);
  }
}

// ── Extract Live Page Context ──────────────────────────────────────────────
async function getActivePageContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) return null;

    if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("edge://") || tab.url?.startsWith("chrome-extension://") || tab.url?.startsWith("about:")) {
      addLog("Cannot inspect browser internal pages", "err");
      return null;
    }

    await ensureContentScript(tab.id);

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => (typeof window.__agy_execute === "function" ? window.__agy_execute("getContext", {}) : null),
    });

    const ctx = results?.[0]?.result;
    if (ctx) {
      return {
        url: ctx.url,
        title: ctx.title,
        selectedText: ctx.selectedText || null,
        text: ctx.text ? ctx.text.slice(0, 10000) : "", // Bound context size
        textLength: ctx.text?.length || 0,
        headings: ctx.headings || []
      };
    }
  } catch (e) {
    console.warn("Could not extract page context:", e);
    addLog(`Context error: ${e.message}`, "err");
  }
  return null;
}

// ── Background Message Listener ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  // Status update
  if (msg.type === "WS_STATUS") {
    setStatus(msg.status);
    addLog(`MCP Server ${msg.status}`, msg.status === "connected" ? "ok" : "err");
  }
});

// ── Tools Tab Buttons ──────────────────────────────────────────────────────
function addLog(msg, type = "info") {
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  const ts = new Date().toLocaleTimeString("en", { hour12: false });
  entry.innerHTML = `<span class="ts">${ts}</span>${escapeHtml(msg)}`;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;
  if (logContainer.children.length > 200) logContainer.removeChild(logContainer.firstChild);
}

document.getElementById("btnReconnect").onclick = () => {
  chrome.runtime.sendMessage({ type: "CONNECT" });
  addLog("Reconnecting to MCP server...", "info");
};

document.getElementById("btnCapture").onclick = async () => {
  addLog("Capturing page context...", "info");
  const ctx = await getActivePageContext();
  if (ctx) {
    addLog(`URL: ${ctx.url}`, "ok");
    addLog(`Title: ${ctx.title}`, "ok");
    addLog(`Text: ${ctx.textLength} chars`, "ok");
    addLog(`Headings: ${ctx.headings?.length || 0}`, "ok");
    if (ctx.selectedText) addLog(`Selection: "${ctx.selectedText.slice(0, 100)}"`, "ok");
  } else {
    addLog("Failed to capture context", "err");
  }
};

document.getElementById("btnScreenshot").onclick = async () => {
  addLog("Taking screenshot...", "info");
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) {
      addLog("No active tab found", "err");
      return;
    }
    if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("edge://") || tab.url?.startsWith("chrome-extension://") || tab.url?.startsWith("about:")) {
      addLog("Cannot screenshot browser internal pages. Switch to regular website tab.", "err");
      return;
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId || null, { format: "png" });
    addLog(`Screenshot captured (${dataUrl.length} bytes)`, "ok");
    const img = document.createElement("img");
    img.src = dataUrl;
    img.style.cssText = "width:100%;border-radius:4px;margin-top:4px;";
    const entry = document.createElement("div");
    entry.className = "log-entry ok";
    entry.appendChild(img);
    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;
  } catch (e) {
    addLog(`Error: ${e.message}`, "err");
  }
};

document.getElementById("btnTabs").onclick = async () => {
  addLog("Listing open tabs...", "info");
  try {
    const tabs = await chrome.tabs.query({});
    tabs.slice(0, 20).forEach((t, i) => {
      addLog(`[${i}] ${t.title?.slice(0, 50)} — ${t.url?.slice(0, 50)}`, t.active ? "ok" : "info");
    });
  } catch (e) {
    addLog(`Error: ${e.message}`, "err");
  }
};

// ── Initial Setup ──────────────────────────────────────────────────────────
updatePageInfo();

chrome.tabs.onActivated.addListener(updatePageInfo);
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status === "complete") updatePageInfo();
});

chrome.runtime.sendMessage({ type: "GET_STATUS" }, (res) => {
  if (res) setStatus(res.status);
});

addLog("Antigravity Browser Bridge loaded", "info");
