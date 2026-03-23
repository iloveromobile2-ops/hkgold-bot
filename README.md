# 港金價格提醒 Telegram Bot

實時監控永豐金融港金賣出價，價格到位自動發送 Telegram 通知。

## Telegram 指令

| 指令 | 說明 |
|------|------|
| `/set 39000` | 設定目標賣出價 |
| `/status` | 查看目前金價和監控狀態 |
| `/cancel` | 取消當前監控 |
| `/help` | 查看指令說明 |

## 運作邏輯

1. 連接永豐金融 WebSocket 獲取實時港金價格
2. 每 10 秒檢查一次賣出價
3. 賣出價 ≤ 目標價時即時 Telegram 通知
4. 通知後自動暫停，等用戶設定新目標價

## 部署到 Railway（推薦）

### 方法一：透過 GitHub

1. 將此項目上傳到你的 GitHub
2. 去 [railway.app](https://railway.app/) 用 GitHub 登入
3. New Project → Deploy from GitHub repo → 選擇此 repo
4. 在 Variables 加入：
   - `TELEGRAM_TOKEN` = `你的Bot Token`
   - `CHAT_ID` = `你的Chat ID`
5. 自動部署完成

### 方法二：Railway CLI

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

然後在 Railway Dashboard 的 Variables 加入 TELEGRAM_TOKEN 和 CHAT_ID。

## 部署到 Render

1. 去 [render.com](https://render.com/) 註冊
2. New → Background Worker
3. 連接 GitHub repo
4. Environment: Node
5. Build Command: `npm install`
6. Start Command: `node index.js`
7. 在 Environment Variables 加入 TELEGRAM_TOKEN 和 CHAT_ID

## 本地運行

```bash
npm install
TELEGRAM_TOKEN=xxx CHAT_ID=xxx node index.js
```
