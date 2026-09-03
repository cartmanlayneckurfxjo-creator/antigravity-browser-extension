// background.js - Service Worker
// Handles: side panel open, content script messaging, WS bridge relay, context menus

const WS_URL = "ws://127.0.0.1:7842";
let ws = null;
let wsReady = false;
let pingInterval = null;

// Open side panel on action click
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Setup Context Menus
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "send-selection",
    title: "🚀 Отправить в Antigravity IDE",
    contexts: ["selection"]
  });
  chrome.contextMenus.create({
    id: "summarize-page",
    title: "📝 Сделать саммари этой страницы",
    contexts: ["page"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "send-selection") {
    const text = info.selectionText || "";
    // Broadcast to sidepanel
    chrome.runtime.sendMessage({
      type: "CONTEXT_MENU_SELECTION",
      text,
      url: tab?.url,
      title: tab?.title
    }).catch(() => {});

    // Send over WS to MCP server
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "user_selection",
        text,
        url: tab?.url,
        title: tab?.title,
        timestamp: Date.now()
      }));
    }
  } else if (info.menuItemId === "summarize-page") {
    if (tab?.id) {
      chrome.sidePanel.open({ tabId: tab.id });
      chrome.runtime.sendMessage({
        type: "TRIGGER_SUMMARIZE",
        tabId: tab.id
      }).catch(() => {});
    }
  }
});

// Keep service worker alive while side panel is open
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "sidepanel-keepalive") {
    console.log("[AGY] Side panel connected (keepalive active)");
    if (!wsReady) connectWS();
    port.onDisconnect.addListener(() => {
      console.log("[AGY] Side panel disconnected");
    });
  }
});

// Connect WebSocket to MCP server
function connectWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    console.warn("[AGY] WS creation error:", e);
    wsReady = false;
    broadcastStatus("error");
    setTimeout(connectWS, 3000);
    return;
  }

  ws.onopen = () => {
    wsReady = true;
    broadcastStatus("connected");
    console.log("[AGY] Connected to MCP server");

    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (wsReady && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 20000);
  };

  ws.onclose = () => {
    wsReady = false;
    if (pingInterval) clearInterval(pingInterval);
    broadcastStatus("disconnected");
    setTimeout(connectWS, 3000); // auto-reconnect
  };

  ws.onerror = () => {
    wsReady = false;
    broadcastStatus("error");
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === "pong") return;

    // Execute RPC command in active tab, return result
    if (msg.method) {
      const result = await executeCommand(msg);
      ws.send(JSON.stringify({ id: msg.id, result }));
    }
  };
}

function broadcastStatus(status) {
  chrome.runtime.sendMessage({ type: "WS_STATUS", status }).catch(() => {});
}

// Execute a command by injecting into active tab
async function executeCommand(cmd) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return { error: "No active tab" };

    switch (cmd.method) {
      case "getContext":
        return await injectAndRun(tab.id, "getContext", cmd.params);
      case "navigate":
        await chrome.tabs.update(tab.id, { url: cmd.params.url });
        await waitTabLoad(tab.id);
        return { ok: true };
      case "click":
        return await injectAndRun(tab.id, "click", cmd.params);
      case "type":
        return await injectAndRun(tab.id, "type", cmd.params);
      case "screenshot":
        return await captureScreenshot(tab, cmd.params);
      case "getTabs":
        return await getTabsList();
      case "switchTab":
        return await switchTab(cmd.params);
      case "scroll":
        return await injectAndRun(tab.id, "scroll", cmd.params);
      case "getElement":
        return await injectAndRun(tab.id, "getElement", cmd.params);
      case "getTranscript":
        return await injectAndRun(tab.id, "getTranscript", cmd.params);
      case "startPicker":
        return await injectAndRun(tab.id, "startPicker", cmd.params);
      case "getArticleText":
        return await injectAndRun(tab.id, "getArticleText", cmd.params);
      case "reload":
        setTimeout(() => chrome.runtime.reload(), 100);
        return { ok: true, message: "Reloading extension" };
      default:
        return { error: `Unknown method: ${cmd.method}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}

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
    console.warn("[AGY] Could not inject content script:", e);
  }
}

async function injectAndRun(tabId, action, params) {
  await ensureContentScript(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (action, params) => {
      if (typeof window.__agy_execute === "function") {
        return await window.__agy_execute(action, params);
      }
      return { error: "Extension script not ready on this page" };
    },
    args: [action, params],
  });
  return results?.[0]?.result ?? { error: "No result" };
}

async function captureScreenshot(tab, params) {
  if (!tab || tab.url?.startsWith("chrome://") || tab.url?.startsWith("edge://") || tab.url?.startsWith("chrome-extension://") || tab.url?.startsWith("about:")) {
    return { error: "Cannot screenshot internal browser pages" };
  }
  const windowId = tab?.windowId || null;
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  return { dataUrl, width: 1920, height: 1080 };
}

async function getTabsList() {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs.map((t, i) => ({ index: i, id: t.id, title: t.title, url: t.url, active: t.active }))
  };
}

async function switchTab({ index, title }) {
  const tabs = await chrome.tabs.query({});
  let target;
  if (index !== undefined) target = tabs[index];
  else if (title) target = tabs.find((t) => t.title?.toLowerCase().includes(title.toLowerCase()));
  if (!target) return { error: "Tab not found" };
  await chrome.tabs.update(target.id, { active: true });
  await chrome.windows.update(target.windowId, { focused: true });
  return { message: `Switched to: ${target.title}` };
}

function waitTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 500);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(resolve, 10000); // timeout
  });
}

// Messages from side panel
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GET_STATUS") {
    sendResponse({ status: wsReady ? "connected" : "disconnected" });
  } else if (msg.type === "CONNECT") {
    connectWS();
    sendResponse({ ok: true });
  }
  return true;
});

// Auto-connect on startup
connectWS();
