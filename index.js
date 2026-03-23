/**
 * 港金價格監控 Telegram Bot
 * 
 * 連接永豐金融 Socket.IO 獲取實時港金價格
 * 每10秒檢查一次，賣出價 ≤ 目標價時 Telegram 通知
 * 
 * Telegram 指令：
 *   /set 39000  - 設定目標賣出價
 *   /status     - 查看目前狀態
 *   /cancel     - 取消監控
 *   /help       - 指令說明
 */

// 永豐金融 SSL 證書鏈不完整，必須在最頂頭設定
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const io = require("socket.io-client");
const https = require("https");
const http = require("http");

// ============ 配置 ============
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "8655406143:AAG3GAeVIkhSTuNcc6OxKOHSLk4FFraMkEo";
const CHAT_ID = process.env.CHAT_ID || "8776701945";
const CHECK_INTERVAL = 10000; // 10秒

const WF_SOCKET_URL = "https://quote.wfgold.com:8082/bquote";
const WF_TOKEN = "applepieapplepieapplepieapplepie";

// ============ 狀態 ============
let currentPrice = null;
let targetPrice = null;
let isAlertActive = false;
let lastPriceTime = null;
let wsConnected = false;
let socket = null;

// ============ Telegram API ============
function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" });
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({}); } });
    });
    req.on("error", (err) => { console.error("[TG] 錯誤:", err.message); reject(err); });
    req.write(data);
    req.end();
  });
}

// ============ Telegram 輪詢 ============
let telegramOffset = 0;

async function pollTelegram() {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/getUpdates?offset=${telegramOffset}&timeout=5`,
      method: "GET",
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (data.ok && data.result.length > 0) {
            for (const update of data.result) {
              telegramOffset = update.update_id + 1;
              if (update.message?.text) handleCommand(update.message.text, update.message.chat.id);
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
    const price = parseInt(text.trim().split(/\s+/)[1], 10);
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
      msg += `📈 最高：${high.toLocaleString()}\n📉 最低：${low.toLocaleString()}\n`;
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
    msg += `\n\n🔌 連線：${wsConnected ? "已連線 ✅" : "斷線 ❌"}`;
    await sendTelegram(msg);

  } else if (cmd === "/cancel") {
    if (isAlertActive) {
      targetPrice = null; isAlertActive = false;
      await sendTelegram("⏸ <b>已取消監控</b>\n\n用 <code>/set 價格</code> 重新設定");
    } else {
      await sendTelegram("ℹ️ 目前沒有在監控\n\n用 <code>/set 價格</code> 設定目標價");
    }

  } else if (cmd === "/start" || cmd === "/help") {
    await sendTelegram(
      `🏆 <b>港金價格提醒 Bot</b>\n\n` +
      `實時監控永豐金融港金賣出價，價格到位自動通知。\n\n` +
      `<b>指令：</b>\n` +
      `<code>/set 39000</code> - 設定目標賣出價\n` +
      `<code>/status</code> - 查看金價和監控狀態\n` +
      `<code>/cancel</code> - 取消監控\n` +
      `<code>/help</code> - 指令說明\n\n` +
      `<b>邏輯：</b>\n` +
      `1️⃣ /set 設定目標\n2️⃣ 每10秒檢查價格\n3️⃣ 賣出價 ≤ 目標即通知\n4️⃣ 通知後暫停，等你設新目標`
    );
  }
}

// ============ 永豐 WebSocket 連接 ============
function connectGoldFeed() {
  console.log("[WS] 連接永豐金融...");

  socket = io(WF_SOCKET_URL, {
    query: { token: WF_TOKEN },
    transports: ["polling", "websocket"],  // 先 polling 再升級 websocket
    rejectUnauthorized: false,
    reconnection: true,
    reconnectionDelay: 5000,
    reconnectionAttempts: Infinity,
  });

  socket.on("connect", () => {
    console.log("[WS] 已連接！Transport:", socket.io.engine.transport.name);
    wsConnected = true;
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

  socket.on("disconnect", () => {
    console.log("[WS] 斷線");
    wsConnected = false;
  });

  socket.on("connect_error", (err) => {
    console.log("[WS] 連接錯誤:", err.message);
    wsConnected = false;
  });

  socket.on("reconnect", (n) => {
    console.log("[WS] 重連成功 (第", n, "次)");
    wsConnected = true;
  });
}

// ============ 價格檢查 ============
function checkPrice() {
  if (!currentPrice || !isAlertActive || !targetPrice) return;
  const sellPrice = parseInt(currentPrice.sell, 10);

  if (sellPrice <= targetPrice) {
    const triggered = targetPrice;
    targetPrice = null;
    isAlertActive = false;

    const msg =
      `🔔🔔🔔 <b>價格到位！</b> 🔔🔔🔔\n\n` +
      `💰 港金賣出價：<b>${sellPrice.toLocaleString()}</b>\n` +
      `🎯 你的目標價：<b>${triggered.toLocaleString()}</b>\n` +
      `📊 買入價：${parseInt(currentPrice.buy, 10).toLocaleString()}\n` +
      `🕐 時間：${currentPrice.timestamp}\n\n` +
      `⏸ 監控已暫停。\n用 <code>/set 價格</code> 設定新目標。`;

    sendTelegram(msg).catch(console.error);
    console.log(`[Alert] 觸發！賣: ${sellPrice} ≤ 目標: ${triggered}`);
  }
}

// ============ 主程式 ============
async function main() {
  console.log("=================================");
  console.log("  港金價格提醒 Telegram Bot");
  console.log("  Chat ID:", CHAT_ID);
  console.log("  間隔:", CHECK_INTERVAL / 1000, "秒");
  console.log("=================================");

  // 連接永豐
  connectGoldFeed();

  // 每10秒檢查
  setInterval(checkPrice, CHECK_INTERVAL);

  // Telegram 指令輪詢
  (async () => { while (true) { await pollTelegram(); await sleep(1000); } })();

  // 健康檢查
  setInterval(() => {
    if (lastPriceTime && Date.now() - lastPriceTime > 90000) {
      console.log("[Health] 90秒無數據，重連...");
      if (socket) try { socket.disconnect(); } catch(e) {}
      connectGoldFeed();
    }
  }, 30000);

  // 等待幾秒讓 WebSocket 連上
  await sleep(5000);
  
  const status = wsConnected ? "已連線 ✅" : "連接中...";
  await sendTelegram(`🚀 <b>Bot 已啟動</b>\n\n🔌 連線：${status}\n\n用 <code>/set 價格</code> 開始監控港金賣出價\n例如：<code>/set 39000</code>`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Railway 需要一個 HTTP 端口 — 必須最先啟動，否則 Railway 會 kill container
const PORT = process.env.PORT || 3000;
http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`OK | Connected: ${wsConnected} | Price: ${currentPrice ? currentPrice.sell : "waiting"} | Alert: ${isAlertActive ? targetPrice : "off"}`);
}).listen(PORT, "0.0.0.0", () => {
  console.log(`[HTTP] Port ${PORT} ready`);
  // HTTP 起好之後先啟動 Bot 主程式
  main().catch(console.error);
});

process.on("uncaughtException", (err) => console.error("[Error]", err));
process.on("unhandledRejection", (err) => console.error("[Error]", err));
