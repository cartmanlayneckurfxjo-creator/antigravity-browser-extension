/**
 * Antigravity Browser MCP Server
 * WS bridge for Chrome extension + MCP stdio for Antigravity IDE
 * Supports multi-instance Master/Relay mode (handles multiple IDE windows/workspaces)
 * 
 * Run standalone:  node server.js --ws-only
 * Run via MCP:     Antigravity IDE starts it automatically
 */

import http from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";

const WS_PORT = 7842;
const WS_ONLY = process.argv.includes("--ws-only");

// ── State ──────────────────────────────────────────────────────────────────
let isMaster = false;
let activeBrowser = null; // Chrome ws (Master only)
let relayWs = null;       // ws to Master (Relay only)
let masterHasBrowser = false;
const pendingRequests = new Map();
let reqId = 0;

// Master state
let httpServer = null;
let wss = null;
const relayClients = new Map();
let nextRelayClientId = 1;

function broadcastToRelays(data) {
  const payload = JSON.stringify(data);
  for (const client of relayClients.values()) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

function initMaster() {
  httpServer = http.createServer();
  wss = new WebSocketServer({ server: httpServer });

  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(`[AGY-Browser-MCP] Port ${WS_PORT} occupied. Switching to Relay mode...\n`);
      if (httpServer) {
        httpServer.close();
        httpServer = null;
      }
      if (wss) {
        wss.close();
        wss = null;
      }
      initRelayClient();
    } else {
      process.stderr.write(`[AGY-Browser-MCP] Server error: ${err.message}\n`);
    }
  });

  wss.on("connection", (ws) => {
    if (!activeBrowser) {
      activeBrowser = ws;
    }

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // 1. Relay Client handshake
        if (msg.type === "relay_hello") {
          if (activeBrowser === ws) {
            activeBrowser = null;
          }
          const clientId = nextRelayClientId++;
          ws.__relayClientId = clientId;
          relayClients.set(clientId, ws);
          process.stderr.write(`[AGY-Browser-MCP] Relay Client #${clientId} connected\n`);
          ws.send(JSON.stringify({
            type: "browser_status",
            connected: !!(activeBrowser && activeBrowser.readyState === 1)
          }));
          return;
        }

        // 2. Request from Relay Client to execute on Chrome
        if (msg.type === "relay_req") {
          const { id, method, params } = msg;
          if (!activeBrowser || activeBrowser.readyState !== 1) {
            ws.send(JSON.stringify({
              type: "relay_res",
              id,
              error: "Chrome extension not connected. Open the side panel in your browser."
            }));
            return;
          }
          const relayReqId = `relay_${ws.__relayClientId}_${id}`;
          const timeout = setTimeout(() => {
            pendingRequests.delete(relayReqId);
            ws.send(JSON.stringify({
              type: "relay_res",
              id,
              error: `Timeout: browser command '${method}' took >15000ms`
            }));
          }, 15000);

          pendingRequests.set(relayReqId, {
            resolve: (result) => {
              clearTimeout(timeout);
              ws.send(JSON.stringify({ type: "relay_res", id, result }));
            },
            reject: (err) => {
              clearTimeout(timeout);
              ws.send(JSON.stringify({ type: "relay_res", id, error: err.message }));
            },
            timeout
          });

          activeBrowser.send(JSON.stringify({ id: relayReqId, method, params }));
          return;
        }

        // 3. Ping
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }

        // 4. Response to RPC request from Chrome
        if (msg.id !== undefined && pendingRequests.has(msg.id)) {
          const { resolve, reject, timeout } = pendingRequests.get(msg.id);
          clearTimeout(timeout);
          pendingRequests.delete(msg.id);
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg.result);
          return;
        }

        // Any regular message from non-relay ws confirms Chrome extension
        if (!ws.__relayClientId && activeBrowser !== ws) {
          activeBrowser = ws;
          broadcastToRelays({ type: "browser_status", connected: true });
        }
      } catch (e) {
        process.stderr.write(`[AGY-Browser-MCP] Parse error: ${e.message}\n`);
      }
    });

    ws.on("close", () => {
      if (ws.__relayClientId) {
        process.stderr.write(`[AGY-Browser-MCP] Relay Client #${ws.__relayClientId} disconnected\n`);
        relayClients.delete(ws.__relayClientId);
      } else if (activeBrowser === ws) {
        process.stderr.write("[AGY-Browser-MCP] Chrome extension disconnected\n");
        activeBrowser = null;
        broadcastToRelays({ type: "browser_status", connected: false });
      }
    });

    process.stderr.write("[AGY-Browser-MCP] Connection received\n");
    broadcastToRelays({ type: "browser_status", connected: !!(activeBrowser && activeBrowser.readyState === 1) });
  });

  httpServer.listen(WS_PORT, () => {
    isMaster = true;
    process.stderr.write(`[AGY-Browser-MCP] WebSocket Master listening on ws://localhost:${WS_PORT}\n`);
    if (WS_ONLY) process.stdout.write(`[AGY-Browser-MCP] Running in WS-only mode\n`);
  });
}

function initRelayClient() {
  isMaster = false;
  try {
    relayWs = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
  } catch (e) {
    setTimeout(initMaster, 2000);
    return;
  }

  relayWs.on("open", () => {
    process.stderr.write("[AGY-Browser-MCP] Connected to Master as Relay Client\n");
    relayWs.send(JSON.stringify({ type: "relay_hello" }));
  });

  relayWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "browser_status") {
        masterHasBrowser = !!msg.connected;
        return;
      }
      if (msg.type === "relay_res") {
        if (msg.id !== undefined && pendingRequests.has(msg.id)) {
          const { resolve, reject, timeout } = pendingRequests.get(msg.id);
          clearTimeout(timeout);
          pendingRequests.delete(msg.id);
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg.result);
        }
        return;
      }
    } catch (e) {
      process.stderr.write(`[AGY-Browser-MCP] Relay parse error: ${e.message}\n`);
    }
  });

  relayWs.on("close", () => {
    masterHasBrowser = false;
    process.stderr.write("[AGY-Browser-MCP] Disconnected from Master. Retrying Master/Relay...\n");
    setTimeout(initMaster, 1500);
  });

  relayWs.on("error", () => {
    // Close event will follow and trigger retry
  });
}

initMaster();

// ── Helper ─────────────────────────────────────────────────────────────────
function sendToExtension(method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Timeout: browser command '${method}' took >${timeoutMs}ms`));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timeout });

    if (isMaster) {
      if (!activeBrowser || activeBrowser.readyState !== 1) {
        clearTimeout(timeout);
        pendingRequests.delete(id);
        return reject(new Error("Chrome extension not connected. Open the side panel in your browser."));
      }
      activeBrowser.send(JSON.stringify({ id, method, params }));
    } else {
      if (!relayWs || relayWs.readyState !== 1) {
        clearTimeout(timeout);
        pendingRequests.delete(id);
        return reject(new Error("MCP bridge relay connecting to Master. Try again in 2s."));
      }
      if (!masterHasBrowser) {
        clearTimeout(timeout);
        pendingRequests.delete(id);
        return reject(new Error("Chrome extension not connected. Open the side panel in your browser."));
      }
      relayWs.send(JSON.stringify({ type: "relay_req", id, method, params }));
    }
  });
}

// ── MCP Tools ──────────────────────────────────────────────────────────────
const mcp = new McpServer({ name: "antigravity-browser", version: "0.2.0" });

// 🌐 Browser Automation Tools
mcp.tool("browser_get_context",
  "Get current browser page: URL, title, text, selected text, headings, links, forms",
  {},
  async () => {
    const r = await sendToExtension("getContext");
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  }
);

mcp.tool("browser_navigate",
  "Navigate current browser tab to a URL",
  { url: z.string().describe("URL to navigate to") },
  async ({ url }) => {
    await sendToExtension("navigate", { url });
    return { content: [{ type: "text", text: `Navigated to ${url}` }] };
  }
);

mcp.tool("browser_click",
  "Click an element by CSS selector or visible text",
  {
    selector: z.string().optional().describe("CSS selector"),
    text: z.string().optional().describe("Visible text of element"),
  },
  async ({ selector, text }) => {
    const r = await sendToExtension("click", { selector, text });
    return { content: [{ type: "text", text: r.message ?? "Clicked" }] };
  }
);

mcp.tool("browser_type",
  "Type text into an input field",
  {
    selector: z.string().optional().describe("CSS selector of input"),
    text: z.string().describe("Text to type"),
    clearFirst: z.boolean().optional().default(false),
  },
  async ({ selector, text, clearFirst }) => {
    const r = await sendToExtension("type", { selector, text, clearFirst });
    return { content: [{ type: "text", text: r.message ?? "Typed" }] };
  }
);

mcp.tool("browser_screenshot",
  "Capture screenshot of current visible page",
  {},
  async () => {
    const r = await sendToExtension("screenshot", {}, 30000);
    const base64 = r.dataUrl.split(",")[1];
    return { content: [{ type: "image", data: base64, mimeType: "image/png" }] };
  }
);

mcp.tool("browser_get_tabs",
  "List all open browser tabs",
  {},
  async () => {
    const r = await sendToExtension("getTabs");
    const lines = r.tabs.map((t) => `[${t.index}] ${t.title} — ${t.url}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

mcp.tool("browser_switch_tab",
  "Switch to a browser tab by index or title",
  {
    index: z.number().optional(),
    title: z.string().optional().describe("Partial tab title"),
  },
  async ({ index, title }) => {
    const r = await sendToExtension("switchTab", { index, title });
    return { content: [{ type: "text", text: r.message ?? "Switched" }] };
  }
);

mcp.tool("browser_scroll",
  "Scroll the page",
  {
    direction: z.enum(["up", "down", "top", "bottom"]).optional(),
    selector: z.string().optional(),
    pixels: z.number().optional(),
  },
  async ({ direction, selector, pixels }) => {
    const r = await sendToExtension("scroll", { direction, selector, pixels });
    return { content: [{ type: "text", text: r.message ?? "Scrolled" }] };
  }
);

mcp.tool("browser_get_element",
  "Get info about a DOM element",
  { selector: z.string().describe("CSS selector") },
  async ({ selector }) => {
    const r = await sendToExtension("getElement", { selector });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  }
);

mcp.tool("browser_get_youtube_transcript",
  "Extract complete subtitles and transcript with timestamps from current YouTube video page",
  {},
  async () => {
    const r = await sendToExtension("getTranscript", {}, 25000);
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  }
);

mcp.tool("browser_pick_element",
  "Launch interactive element picker in browser. User clicks an element on page; returns its CSS selector and details",
  {},
  async () => {
    const r = await sendToExtension("startPicker", {}, 60000);
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  }
);

mcp.tool("browser_get_article",
  "Extract clean readable article text without ads, banners, or navbars for summarization",
  {},
  async () => {
    const r = await sendToExtension("getArticleText");
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  }
);

// ── Start ──────────────────────────────────────────────────────────────────
if (!WS_ONLY) {
  // MCP mode: connect to IDE via stdio
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
} else {
  // Standalone: just keep alive for WS
  setInterval(() => {}, 1000 * 60 * 60);
  process.stdin.resume();
  process.on("SIGINT", () => {
    if (httpServer) httpServer.close();
    process.exit(0);
  });
  process.stderr.write("[AGY-Browser-MCP] Press Ctrl+C to stop\n");
}
