/**
 * 港金價格監控 Telegram Bot
 * 
 * 功能：
 * - 連接永豐金融 WebSocket 獲取實時港金價格
 * - 如果 WebSocket 失敗，自動切換到 HTTP 輪詢模式
 * - 每10秒檢查一次價格
 * - 賣出價 ≤ 目標價時發送 Telegram 通知
 * - 觸發一次後暫停，等用戶設定新目標價
 * 
 * Telegram 指令：
 *   /set 39000     - 設定目標賣出價
 *   /status        - 查看目前狀態
 *   /cancel        - 取消當前監控
 *   /help          - 查看指令說明
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const https = require("https");
const http = require("http");

// ============ 配置 ============
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "8655406143:AAGYxxhB9H3BgS-yrguT68xJpgVH_Oku_LQ";
const CHAT_ID = process.env.CHAT_ID || "8776701945";
const PRICE_CHECK_INTERVAL = 10000; // 10秒

// 永豐金融
const WF_SOCKET_URL = "https://quote.wfgold.com:8082/bquote";
const WF_TOKEN = "applepieapplepieapplepieapplepie";

// ============ 狀態 ============
let currentPrice = null;
let targetPrice = null;
let isAlertActive = false;
let lastPriceTime = null;
let wsConnected = false;
let connectionMode = "none"; // "websocket" | "polling" | "none"
let socket = null;

// ============ Telegram API ============
function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      chat_id: CHAT_ID,
      text: text,
      parse_mode: "HTML",
    });
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch(e) { resolve({}); }
      });
    });
    req.on("error", (err) => { console.error("[TG] 發送失敗:", err.message); reject(err); });
    req.write(data);
    req.end();
  });
}

// ============ Telegram 輪詢 ============
let telegramOffset = 0;

async function pollTelegram() {
  return new Promise((resolve) => {
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/getUpdates?offset=${telegramOffset}&timeout=5`,
      method: "GET",
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (data.ok && data.result.length > 0) {
            for (const update of data.result) {
              telegramOffset = update.update_id + 1;
              if (update.message && update.message.text) {
                handleCommand(update.message.text, update.message.chat.id);
              }
            }
          }
        } catch (e) { /* ignore */ }
        resolve();
      });
    });
    req.on("error", () => resolve());
    req.setTimeout(10000, () => { req.destroy(); resolve(); });
    req.end();
  });
}

// ============ 指令處理 ============
async function handleCommand(text, chatId) {
  if (String(chatId) !== String(CHAT_ID)) return;
  const cmd = text.trim().toLowerCase();

  if (cmd.startsWith("/set")) {
    const parts = text.trim().split(/\s+/);
    const price = parseInt(parts[1], 10);
    if (isNaN(price) || price <= 0) {
      await sendTelegram("❌ 格式錯誤\n\n用法：<code>/set 39000</code>");
      return;
    }
    targetPrice = price;
    isAlertActive = true;
    let msg = `✅ <b>目標價已設定</b>\n\n🎯 目標賣出價 ≤ <b>${price.toLocaleString()}</b>\n`;
    if (currentPrice) {
      const sell = parseInt(currentPrice.sell, 10);
      msg += `📊 當前賣出價：<b>${sell.toLocaleString()}</b>\n`;
      msg += `📏 距離目標：<b>${(sell - price).toLocaleString()}</b>\n`;
    }
    msg += `\n當賣出價到達目標，系統會立即通知你。`;
    await sendTelegram(msg);
    console.log(`[Alert] 目標價: ${price}`);

  } else if (cmd === "/status") {
    let msg = `📊 <b>港金監控狀態</b>\n\n`;
    if (currentPrice) {
      const sell = parseInt(currentPrice.sell, 10);
      const buy = parseInt(currentPrice.buy, 10);
      const close = parseInt(currentPrice.closeprice, 10);
      const change = sell - close;
      const pct = close ? ((change / close) * 100).toFixed(2) : "0.00";
      const high = currentPrice.dayhigh ? parseInt(currentPrice.dayhigh.split(" ")[0], 10) : 0;
      const low = currentPrice.daylow ? parseInt(currentPrice.daylow.split(" ")[0], 10) : 0;
      msg += `💰 賣出：<b>${sell.toLocaleString()}</b>\n`;
      msg += `💵 買入：<b>${buy.toLocaleString()}</b>\n`;
      msg += `📈 最高：${high.toLocaleString()}\n`;
      msg += `📉 最低：${low.toLocaleString()}\n`;
      msg += `📊 收市：${close.toLocaleString()}\n`;
      msg += `${change >= 0 ? "🟢" : "🔴"} 變動：${change >= 0 ? "+" : ""}${change.toLocaleString()} (${change >= 0 ? "+" : ""}${pct}%)\n`;
      msg += `🕐 時間：${currentPrice.timestamp}\n\n`;
    } else {
      msg += `⏳ 等待價格數據...\n\n`;
    }
    if (isAlertActive && targetPrice) {
      const sell = currentPrice ? parseInt(currentPrice.sell, 10) : 0;
      msg += `🎯 目標價：<b>${targetPrice.toLocaleString()}</b>\n`;
      msg += `📏 距離目標：<b>${(sell - targetPrice).toLocaleString()}</b>\n`;
      msg += `🟢 狀態：監控中`;
    } else {
      msg += `⏸ 狀態：未設定目標價\n用 <code>/set 價格</code> 開始監控`;
    }
    msg += `\n\n🔌 連線：${wsConnected ? "已連線 ✅" : "斷線 ❌"} (${connectionMode})`;
    await sendTelegram(msg);

  } else if (cmd === "/cancel") {
    if (isAlertActive) {
      targetPrice = null;
      isAlertActive = false;
      await sendTelegram("⏸ <b>已取消監控</b>\n\n用 <code>/set 價格</code> 重新設定");
    } else {
      await sendTelegram("ℹ️ 目前沒有在監控\n\n用 <code>/set 價格</code> 設定目標價");
    }

  } else if (cmd === "/start" || cmd === "/help") {
    let msg = `🏆 <b>港金價格提醒 Bot</b>\n\n`;
    msg += `實時監控永豐金融港金賣出價，價格到位自動通知。\n\n`;
    msg += `<b>指令：</b>\n`;
    msg += `<code>/set 39000</code> - 設定目標賣出價\n`;
    msg += `<code>/status</code> - 查看金價和監控狀態\n`;
    msg += `<code>/cancel</code> - 取消監控\n`;
    msg += `<code>/help</code> - 指令說明\n\n`;
    msg += `<b>邏輯：</b>\n`;
    msg += `1️⃣ /set 設定目標\n`;
    msg += `2️⃣ 每10秒檢查價格\n`;
    msg += `3️⃣ 賣出價 ≤ 目標即通知\n`;
    msg += `4️⃣ 通知後暫停，等你設新目標`;
    await sendTelegram(msg);
  }
}

// ============ 方式一：WebSocket 連接永豐 ============
function connectWebSocket() {
  return new Promise((resolve) => {
    try {
      const io = require("socket.io-client");
      console.log("[WS] 嘗試 WebSocket 連接...");

      socket = io(WF_SOCKET_URL, {
        query: { token: WF_TOKEN },
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionDelay: 5000,
        reconnectionAttempts: 5, // 只試5次，失敗就切換到 polling
        timeout: 10000,
      });

      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          console.log("[WS] 連接超時");
          resolve(false);
        }
      }, 15000);

      socket.on("connect", () => {
        console.log("[WS] WebSocket 已連接！");
        wsConnected = true;
        connectionMode = "websocket";
        if (!resolved) { resolved = true; clearTimeout(timer); resolve(true); }
      });

      socket.on("quote.realtime", (data) => {
        try {
          const hkg = data?.products?.["HKG="];
          if (hkg) {
            currentPrice = {
              buy: hkg.buy, sell: hkg.sell,
              dayhigh: hkg.dayhigh, daylow: hkg.daylow,
              closeprice: hkg.closeprice,
              timestamp: data?.tz?.hkg || new Date().toLocaleTimeString("zh-HK"),
            };
            lastPriceTime = Date.now();
          }
        } catch (e) { /* ignore */ }
      });

      socket.on("disconnect", () => { wsConnected = false; });
      socket.on("reconnect_failed", () => {
        console.log("[WS] 重連失敗，切換到 HTTP 輪詢");
        wsConnected = false;
        if (!resolved) { resolved = true; clearTimeout(timer); resolve(false); }
      });
      socket.on("connect_error", (err) => {
        console.log("[WS] 連接錯誤:", err.message);
        wsConnected = false;
      });

    } catch (e) {
      console.log("[WS] socket.io-client 載入失敗:", e.message);
      resolve(false);
    }
  });
}

// ============ 方式二：HTTP 輪詢（備用） ============
// 透過永豐的 Socket.IO HTTP polling 端點獲取數據
function fetchPriceHTTP() {
  return new Promise((resolve) => {
    // Step 1: 拿 session ID
    const url = `https://quote.wfgold.com:8082/socket.io/?token=${WF_TOKEN}&EIO=3&transport=polling`;
    
    httpsGet(url, (body) => {
      try {
        // Socket.IO polling 回應格式: 數字:JSON
        // 先拿到 sid
        const match = body.match(/"sid":"([^"]+)"/);
        if (!match) { resolve(false); return; }
        const sid = match[1];

        // Step 2: 用 sid 獲取數據
        setTimeout(() => {
          const dataUrl = `https://quote.wfgold.com:8082/socket.io/?token=${WF_TOKEN}&EIO=3&transport=polling&sid=${sid}`;
          httpsGet(dataUrl, (body2) => {
            try {
              // 解析 Socket.IO 的 polling 消息格式
              const jsonMatches = body2.match(/\{[^{}]*"products"[^}]*\{[\s\S]*?\}\s*\}/g);
              if (jsonMatches) {
                for (const jsonStr of jsonMatches) {
                  try {
                    const data = JSON.parse(jsonStr);
                    const hkg = data?.products?.["HKG="];
                    if (hkg) {
                      currentPrice = {
                        buy: hkg.buy, sell: hkg.sell,
                        dayhigh: hkg.dayhigh, daylow: hkg.daylow,
                        closeprice: hkg.closeprice,
                        timestamp: data?.tz?.hkg || new Date().toLocaleTimeString("zh-HK"),
                      };
                      lastPriceTime = Date.now();
                      wsConnected = true;
                      resolve(true);
                      return;
                    }
                  } catch(e) { /* try next */ }
                }
              }

              // 嘗試另一種解析方式
              const allJson = extractJsonObjects(body2);
              for (const obj of allJson) {
                if (obj.products && obj.products["HKG="]) {
                  const hkg = obj.products["HKG="];
                  currentPrice = {
                    buy: hkg.buy, sell: hkg.sell,
                    dayhigh: hkg.dayhigh, daylow: hkg.daylow,
                    closeprice: hkg.closeprice,
                    timestamp: obj?.tz?.hkg || new Date().toLocaleTimeString("zh-HK"),
                  };
                  lastPriceTime = Date.now();
                  wsConnected = true;
                  resolve(true);
                  return;
                }
              }
              resolve(false);
            } catch(e) { resolve(false); }
          }, () => resolve(false));
        }, 1000);

      } catch(e) { resolve(false); }
    }, () => resolve(false));
  });
}

function extractJsonObjects(str) {
  const results = [];
  let depth = 0; let start = -1;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (str[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try { results.push(JSON.parse(str.substring(start, i + 1))); } catch(e) {}
        start = -1;
      }
    }
  }
  return results;
}

function httpsGet(url, onSuccess, onError) {
  https.get(url, { timeout: 10000 }, (res) => {
    let body = "";
    res.on("data", (c) => body += c);
    res.on("end", () => onSuccess(body));
  }).on("error", (e) => {
    console.log("[HTTP] 錯誤:", e.message);
    if (onError) onError(e);
  });
}

// HTTP 輪詢循環
async function startHTTPPolling() {
  connectionMode = "polling";
  console.log("[HTTP] 啟動 HTTP 輪詢模式（每10秒）");
  
  async function poll() {
    try {
      const ok = await fetchPriceHTTP();
      if (ok) {
        wsConnected = true;
      } else {
        // 如果 HTTP polling 也失敗，嘗試抓取網頁
        wsConnected = false;
      }
    } catch(e) {
      wsConnected = false;
    }
  }

  // 立即執行一次
  await poll();

  // 每10秒輪詢
  setInterval(poll, PRICE_CHECK_INTERVAL);
}

// ============ 價格檢查 ============
function checkPrice() {
  if (!currentPrice || !isAlertActive || !targetPrice) return;
  const sellPrice = parseInt(currentPrice.sell, 10);

  if (sellPrice <= targetPrice) {
    const triggered = targetPrice;
    targetPrice = null;
    isAlertActive = false;

    let msg = `🔔🔔🔔 <b>價格到位！</b> 🔔🔔🔔\n\n`;
    msg += `💰 港金賣出價：<b>${sellPrice.toLocaleString()}</b>\n`;
    msg += `🎯 你的目標價：<b>${triggered.toLocaleString()}</b>\n`;
    msg += `📊 買入價：${parseInt(currentPrice.buy, 10).toLocaleString()}\n`;
    msg += `🕐 時間：${currentPrice.timestamp}\n\n`;
    msg += `⏸ 監控已暫停。\n用 <code>/set 價格</code> 設定新目標。`;

    sendTelegram(msg).catch(console.error);
    console.log(`[Alert] 觸發！賣: ${sellPrice} ≤ 目標: ${triggered}`);
  }
}

// ============ 主程式 ============
async function main() {
  console.log("=================================");
  console.log("  港金價格提醒 Telegram Bot");
  console.log("  Chat ID:", CHAT_ID);
  console.log("  間隔:", PRICE_CHECK_INTERVAL / 1000, "秒");
  console.log("=================================");

  // 嘗試 WebSocket 連接
  const wsOk = await connectWebSocket();
  
  if (wsOk) {
    console.log("[啟動] WebSocket 模式");
    connectionMode = "websocket";
  } else {
    // WebSocket 失敗，切到 HTTP polling
    console.log("[啟動] WebSocket 失敗，切換到 HTTP 輪詢模式");
    if (socket) { try { socket.disconnect(); } catch(e) {} }
    await startHTTPPolling();
  }

  // 每10秒檢查價格
  setInterval(checkPrice, PRICE_CHECK_INTERVAL);

  // Telegram 指令輪詢
  (async function telegramLoop() {
    while (true) {
      await pollTelegram();
      await sleep(1000);
    }
  })();

  // 健康檢查：60秒沒收到數據就嘗試重連
  setInterval(() => {
    if (lastPriceTime && Date.now() - lastPriceTime > 60000) {
      console.log("[Health] 60秒無數據，嘗試重連...");
      if (connectionMode === "websocket" && socket) {
        try { socket.disconnect(); } catch(e) {}
        connectWebSocket().then(ok => {
          if (!ok) {
            console.log("[Health] WebSocket 重連失敗，切換到 HTTP 輪詢");
            startHTTPPolling();
          }
        });
      }
      // HTTP polling 會自動重試
    }
  }, 30000);

  // 啟動通知
  const modeText = connectionMode === "websocket" ? "WebSocket 實時" : "HTTP 輪詢（每10秒）";
  await sendTelegram(`🚀 <b>Bot 已啟動</b>\n\n連線模式：${modeText}\n\n用 <code>/set 價格</code> 開始監控港金賣出價\n例如：<code>/set 39000</code>`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 保持 Railway 的 web 進程活著（如果需要的話）
const PORT = process.env.PORT;
if (PORT) {
  http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`HK Gold Bot running. Mode: ${connectionMode}. Price: ${currentPrice ? currentPrice.sell : "N/A"}`);
  }).listen(PORT, () => {
    console.log(`[HTTP] Health check server on port ${PORT}`);
  });
}

main().catch(console.error);

process.on("uncaughtException", (err) => console.error("[Error]", err));
process.on("unhandledRejection", (err) => console.error("[Error]", err));
