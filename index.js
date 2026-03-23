/**
 * 港金價格監控 Telegram Bot
 * 
 * 功能：
 * - 連接永豐金融 WebSocket 獲取實時港金價格
 * - 每10秒檢查一次價格
 * - 賣出價 ≤ 目標價時發送 Telegram 通知
 * - 觸發一次後暫停，等用戶設定新目標價
 * - 支援 Telegram 指令控制
 * 
 * Telegram 指令：
 *   /set 39000     - 設定目標賣出價
 *   /status        - 查看目前狀態（金價 + 目標價）
 *   /cancel        - 取消當前監控
 *   /help          - 查看指令說明
 */

const io = require("socket.io-client");
const https = require("https");

// ============ 配置 ============
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "8655406143:AAG3GAeVIkhSTuNcc6OxKOHSLk4FFraMkEo";
const CHAT_ID = process.env.CHAT_ID || "8776701945";
const CHECK_INTERVAL = 10000; // 10秒檢查一次

// 永豐金融 WebSocket
const WF_SOCKET_URL = "https://quote.wfgold.com:8082/bquote";
const WF_TOKEN = "applepieapplepieapplepieapplepie";

// ============ 狀態 ============
let currentPrice = null;     // 當前港金數據
let targetPrice = null;      // 目標賣出價（null = 未設定/已觸發）
let isAlertActive = false;   // 是否正在監控
let lastCheckTime = null;    // 上次檢查時間
let lastPriceTime = null;    // 上次收到價格的時間
let wsConnected = false;     // WebSocket 連接狀態

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
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve(JSON.parse(body)));
    });

    req.on("error", (err) => {
      console.error("[Telegram] 發送失敗:", err.message);
      reject(err);
    });

    req.write(data);
    req.end();
  });
}

// 輪詢 Telegram 訊息（接收用戶指令）
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
        } catch (e) {
          console.error("[Telegram] 解析錯誤:", e.message);
        }
        resolve();
      });
    });

    req.on("error", (err) => {
      console.error("[Telegram] 輪詢錯誤:", err.message);
      resolve();
    });

    req.setTimeout(10000, () => {
      req.destroy();
      resolve();
    });

    req.end();
  });
}

// 處理用戶指令
async function handleCommand(text, chatId) {
  // 只回應指定的 Chat ID
  if (String(chatId) !== String(CHAT_ID)) return;

  const cmd = text.trim().toLowerCase();

  if (cmd.startsWith("/set")) {
    const parts = text.trim().split(/\s+/);
    const price = parseInt(parts[1], 10);

    if (isNaN(price) || price <= 0) {
      await sendTelegram("❌ 格式錯誤\n\n用法：<code>/set 39000</code>\n輸入你想監控的目標賣出價");
      return;
    }

    targetPrice = price;
    isAlertActive = true;

    let msg = `✅ <b>目標價已設定</b>\n\n`;
    msg += `🎯 目標賣出價 ≤ <b>${price.toLocaleString()}</b>\n`;
    if (currentPrice) {
      const sell = parseInt(currentPrice.sell, 10);
      const diff = sell - price;
      msg += `📊 當前賣出價：<b>${sell.toLocaleString()}</b>\n`;
      msg += `📏 距離目標：<b>${diff.toLocaleString()}</b>\n`;
    }
    msg += `\n當賣出價到達目標，系統會立即通知你。`;

    await sendTelegram(msg);
    console.log(`[Alert] 新目標價設定: ${price}`);

  } else if (cmd === "/status") {
    let msg = `📊 <b>港金監控狀態</b>\n\n`;

    if (currentPrice) {
      const sell = parseInt(currentPrice.sell, 10);
      const buy = parseInt(currentPrice.buy, 10);
      const close = parseInt(currentPrice.closeprice, 10);
      const change = sell - close;
      const changePct = close ? ((change / close) * 100).toFixed(2) : "0.00";
      const highStr = currentPrice.dayhigh ? currentPrice.dayhigh.split(" ")[0] : "---";
      const lowStr = currentPrice.daylow ? currentPrice.daylow.split(" ")[0] : "---";

      msg += `💰 賣出：<b>${sell.toLocaleString()}</b>\n`;
      msg += `💵 買入：<b>${buy.toLocaleString()}</b>\n`;
      msg += `📈 最高：${parseInt(highStr, 10).toLocaleString()}\n`;
      msg += `📉 最低：${parseInt(lowStr, 10).toLocaleString()}\n`;
      msg += `📊 收市：${close.toLocaleString()}\n`;
      msg += `${change >= 0 ? "🟢" : "🔴"} 變動：${change >= 0 ? "+" : ""}${change.toLocaleString()} (${change >= 0 ? "+" : ""}${changePct}%)\n`;
      msg += `🕐 時間：${currentPrice.timestamp}\n\n`;
    } else {
      msg += `⏳ 等待價格數據...\n\n`;
    }

    if (isAlertActive && targetPrice) {
      const sell = currentPrice ? parseInt(currentPrice.sell, 10) : 0;
      const diff = sell - targetPrice;
      msg += `🎯 目標價：<b>${targetPrice.toLocaleString()}</b>\n`;
      msg += `📏 距離目標：<b>${diff.toLocaleString()}</b>\n`;
      msg += `🟢 狀態：監控中`;
    } else {
      msg += `⏸ 狀態：未設定目標價\n`;
      msg += `用 <code>/set 價格</code> 開始監控`;
    }

    msg += `\n\n🔌 連線：${wsConnected ? "已連線 ✅" : "斷線 ❌"}`;

    await sendTelegram(msg);

  } else if (cmd === "/cancel") {
    if (isAlertActive) {
      targetPrice = null;
      isAlertActive = false;
      await sendTelegram("⏸ <b>已取消監控</b>\n\n用 <code>/set 價格</code> 重新設定目標價");
      console.log("[Alert] 監控已取消");
    } else {
      await sendTelegram("ℹ️ 目前沒有在監控中\n\n用 <code>/set 價格</code> 設定目標價");
    }

  } else if (cmd === "/start" || cmd === "/help") {
    let msg = `🏆 <b>港金價格提醒 Bot</b>\n\n`;
    msg += `此 Bot 實時監控永豐金融港金賣出價，\n價格到位自動通知你。\n\n`;
    msg += `<b>指令列表：</b>\n`;
    msg += `<code>/set 39000</code> - 設定目標賣出價\n`;
    msg += `<code>/status</code> - 查看目前金價和監控狀態\n`;
    msg += `<code>/cancel</code> - 取消當前監控\n`;
    msg += `<code>/help</code> - 查看指令說明\n\n`;
    msg += `<b>運作邏輯：</b>\n`;
    msg += `1️⃣ 用 /set 設定目標賣出價\n`;
    msg += `2️⃣ 系統每10秒檢查一次價格\n`;
    msg += `3️⃣ 賣出價 ≤ 目標價時即時通知\n`;
    msg += `4️⃣ 通知後自動暫停，等你設新目標\n`;

    await sendTelegram(msg);
  }
}

// ============ 永豐金融 WebSocket ============
let socket = null;
let reconnectTimer = null;

function connectGoldFeed() {
  console.log("[WS] 正在連接永豐金融...");

  socket = io(WF_SOCKET_URL, {
    query: { token: WF_TOKEN },
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelay: 5000,
    reconnectionAttempts: Infinity,
  });

  socket.on("connect", () => {
    console.log("[WS] 已連接永豐金融 WebSocket");
    wsConnected = true;
  });

  socket.on("quote.realtime", (data) => {
    try {
      const hkg = data?.products?.["HKG="];
      if (hkg) {
        currentPrice = {
          buy: hkg.buy,
          sell: hkg.sell,
          dayhigh: hkg.dayhigh,
          daylow: hkg.daylow,
          closeprice: hkg.closeprice,
          timestamp: data?.tz?.hkg || new Date().toLocaleTimeString("zh-HK"),
        };
        lastPriceTime = Date.now();
      }
    } catch (err) {
      console.error("[WS] 數據解析錯誤:", err.message);
    }
  });

  socket.on("disconnect", () => {
    console.log("[WS] 斷線");
    wsConnected = false;
  });

  socket.on("connect_error", (err) => {
    console.error("[WS] 連接錯誤:", err.message);
    wsConnected = false;
  });
}

// ============ 價格檢查（每10秒） ============
function checkPrice() {
  if (!currentPrice || !isAlertActive || !targetPrice) return;

  const sellPrice = parseInt(currentPrice.sell, 10);
  lastCheckTime = new Date().toLocaleTimeString("zh-HK", { timeZone: "Asia/Hong_Kong" });

  if (sellPrice <= targetPrice) {
    // 觸發！
    const triggeredTarget = targetPrice;
    targetPrice = null;
    isAlertActive = false;

    let msg = `🔔🔔🔔 <b>價格到位！</b> 🔔🔔🔔\n\n`;
    msg += `💰 港金賣出價：<b>${sellPrice.toLocaleString()}</b>\n`;
    msg += `🎯 你的目標價：<b>${triggeredTarget.toLocaleString()}</b>\n`;
    msg += `📊 買入價：${parseInt(currentPrice.buy, 10).toLocaleString()}\n`;
    msg += `🕐 時間：${currentPrice.timestamp}\n\n`;
    msg += `⏸ 監控已暫停。\n用 <code>/set 價格</code> 設定新目標價繼續監控。`;

    sendTelegram(msg).catch(console.error);
    console.log(`[Alert] 觸發！ 賣出價 ${sellPrice} ≤ 目標 ${triggeredTarget}`);
  }
}

// ============ 主程式 ============
async function main() {
  console.log("=================================");
  console.log("  港金價格提醒 Telegram Bot");
  console.log("  Chat ID:", CHAT_ID);
  console.log("  檢查間隔:", CHECK_INTERVAL / 1000, "秒");
  console.log("=================================");

  // 1. 連接永豐金融 WebSocket
  connectGoldFeed();

  // 2. 每10秒檢查一次價格
  setInterval(checkPrice, CHECK_INTERVAL);

  // 3. 持續輪詢 Telegram 訊息（接收用戶指令）
  async function telegramLoop() {
    while (true) {
      await pollTelegram();
      await sleep(1000);
    }
  }
  telegramLoop();

  // 4. 定時健康檢查 — 如果超過60秒沒收到價格，嘗試重連
  setInterval(() => {
    if (lastPriceTime && Date.now() - lastPriceTime > 60000) {
      console.log("[Health] 超過60秒沒收到價格，重連中...");
      if (socket) {
        socket.disconnect();
      }
      connectGoldFeed();
    }
  }, 30000);

  // 發送啟動訊息
  await sendTelegram("🚀 <b>Bot 已啟動</b>\n\n用 <code>/set 價格</code> 開始監控港金賣出價\n例如：<code>/set 39000</code>");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 啟動
main().catch(console.error);

// 保持進程運行
process.on("uncaughtException", (err) => {
  console.error("[Error] 未捕獲異常:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("[Error] 未處理的 Promise 拒絕:", err);
});
