// sidepanel.js - Antigravity Browser Bridge & AI Chat
// Handles: UI tabs, chat messaging, live page context, inspector, and MCP tools

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

// ── Content Script Auto-Injection & Runner ─────────────────────────────────
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

async function runInActiveTab(action, params = {}) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) return { error: "No active tab found" };
    if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("edge://") || tab.url?.startsWith("chrome-extension://") || tab.url?.startsWith("about:")) {
      return { error: "Cannot run on browser internal pages. Switch to regular website tab." };
    }
    await ensureContentScript(tab.id);
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (action, params) => {
        if (typeof window.__agy_execute === "function") {
          return await window.__agy_execute(action, params);
        }
        return { error: "Extension script not ready" };
      },
      args: [action, params]
    });
    return results?.[0]?.result ?? { error: "No response from page" };
  } catch (e) {
    return { error: e.message };
  }
}

// ── Extract Live Page Context ──────────────────────────────────────────────
async function getActivePageContext() {
  const ctx = await runInActiveTab("getContext");
  if (ctx && !ctx.error) {
    return {
      url: ctx.url,
      title: ctx.title,
      selectedText: ctx.selectedText || null,
      text: ctx.text ? ctx.text.slice(0, 10000) : "",
      textLength: ctx.text?.length || 0,
      headings: ctx.headings || []
    };
  }
  return null;
}

// ── Background Message Listener ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "WS_STATUS") {
    setStatus(msg.status);
    addLog(`MCP Server ${msg.status}`, msg.status === "connected" ? "ok" : "err");
  } else if (msg.type === "CONTEXT_MENU_SELECTION") {
    addLog(`🚀 [Selection -> IDE]: "${msg.text.slice(0, 100)}${msg.text.length > 100 ? '...' : ''}"`, "ok");
  } else if (msg.type === "TRIGGER_SUMMARIZE") {
    document.getElementById("btnSummarize").click();
  }
});

// ── Logging UI ─────────────────────────────────────────────────────────────
function addLog(msg, type = "info") {
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  const ts = new Date().toLocaleTimeString("en", { hour12: false });
  entry.innerHTML = `<span class="ts">${ts}</span>${escapeHtml(msg)}`;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;
  if (logContainer.children.length > 200) logContainer.removeChild(logContainer.firstChild);
}

// ── Buttons ────────────────────────────────────────────────────────────────
document.getElementById("btnReconnect").onclick = () => {
  chrome.runtime.sendMessage({ type: "CONNECT" });
  addLog("Reconnecting to MCP server...", "info");
};

document.getElementById("btnClearLog").onclick = () => {
  logContainer.innerHTML = "";
  addLog("Log cleared", "info");
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
    addLog("Failed to capture context (switch to standard web tab)", "err");
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

document.getElementById("btnSummarize").onclick = async () => {
  addLog("📝 Extracting clean page content...", "info");
  const res = await runInActiveTab("getArticleText");
  if (res.error) {
    addLog(`Summary error: ${res.error}`, "err");
    return;
  }
  const text = res.text || "";
  if (!text) {
    addLog("No readable text found on page", "err");
    return;
  }
  addLog(`📄 Title: ${res.title}`, "ok");
  const paragraphs = text.split("\n\n").filter(p => p.trim().length > 35).slice(0, 6);
  paragraphs.forEach((p) => {
    addLog(`• ${p.trim().slice(0, 160)}${p.length > 160 ? '...' : ''}`, "info");
  });
  addLog("Summary ready", "ok");
};

document.getElementById("btnPick").onclick = async () => {
  addLog("🎯 Click any element on page (Esc to cancel)...", "info");
  const res = await runInActiveTab("startPicker");
  if (res.error) {
    addLog(`Picker error: ${res.error}`, "err");
  } else if (res.cancelled) {
    addLog("Element picker cancelled", "info");
  } else {
    addLog(`🎯 Picked: <${res.tag}> "${res.selector}"`, "ok");
    if (res.text) addLog(`Text: "${res.text}"`, "info");
    addLog("📋 Selector copied to clipboard!", "ok");
  }
};

document.getElementById("btnTranscript").onclick = async () => {
  addLog("🎬 Extracting YouTube transcript...", "info");
  const res = await runInActiveTab("getTranscript");
  if (res.error) {
    addLog(`Transcript error: ${res.error}`, "err");
    return;
  }
  addLog(`🎬 Video: ${res.videoTitle}`, "ok");
  addLog(`Found ${res.totalCues} timestamps/subtitles`, "ok");
  const preview = res.cues.slice(0, 3).map(c => `[${c.time}] ${c.text}`).join("\n");
  addLog(`Preview:\n${preview}\n...`, "info");
  try {
    await navigator.clipboard.writeText(res.fullText);
    addLog("📋 Full transcript copied to clipboard!", "ok");
  } catch {}
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
