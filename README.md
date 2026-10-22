# LINE AI 待辦小秘書 ＋ 本地搜尋轉接站 (Search Relay)

本專案整合了 **Google Apps Script (LINE Bot)** 與 **本地 Ollama 模型轉接站 (Search Relay)**：
1. **日常生活待辦管理**：文字或照片輸入，由雲端 Gemini 解析待辦事項，寫入 Google 試算表並自動排入 Google 日曆。
2. **即時聯網問答**：輸入「`查 …`」或「`搜尋 …`」開頭的訊息，自動路由至本地執行的轉接站，由本機 Ollama 搭配即時網路搜尋（Web Search / Fetch）獲取最新資訊後回覆，並附上參考來源。

---

## 📁 檔案結構

```text
├── Code.gs                 # Google Apps Script 主要程式碼（LINE Bot 入口與邏輯）
├── appsscript.json         # Google Apps Script 資訊清單（權限與環境配置）
├── line-search-relay.mjs   # 本地模型轉接站（Node.js，介接 Ollama、搜尋工具與 Cloudflare Tunnel）
├── README.md               # 專案安裝、執行與改動紀錄說明
└── .gitignore              # Git 忽略檔（排除本機金鑰與暫存檔案）
```

---

## 🛠️ 怎麼裝（安裝與前置設定）

### 1. 本地電腦環境準備

1. **安裝 Node.js**（v18 以上，支援原生 `fetch` 與 ESM）。
2. **安裝並啟動 Ollama**：
   - 下載安裝 [Ollama](https://ollama.com/)。
   - 下載指定模型（預設為 `gemma4:e4b`，亦可自行更換）：
     ```bash
     ollama pull gemma4:e4b
     ```
3. **（可選）Cloudflare Tunnel (`cloudflared`)**：
   - `line-search-relay.mjs` 預設會自動偵測或下載通道程式，提供外部安全的 HTTPS 連線網址。

### 2. Google Apps Script 設定

1. 在 Google 雲端硬碟建立一份新的「Google 試算表」。
2. 點選選單「**擴充功能** → **Apps Script**」。
3. 將本專案的 `Code.gs` 與 `appsscript.json` 複製貼上至 Apps Script 編輯器中。
4. 點選左側齒輪「**專案設定**」，在「**指令碼屬性**」新增以下鍵值：
   - `LINE_CHANNEL_ACCESS_TOKEN`：（必填）LINE Developers 後台發行的 Messaging API Channel Access Token。
   - `GEMINI_API_KEY`：（必填）Google AI Studio 申請的 Gemini API Key。
   - `SEARCH_RELAY_URL`：（必填）本機轉接站啟動時產生的 Cloudflare Tunnel HTTPS 網址。
   - `SEARCH_RELAY_KEY`：（必填）本機轉接站的通關密碼（啟動時自動產生或自訂）。
   - `SHEET_ID`：（選填）綁定的 Google 試算表 ID（若是從試算表內建選單開啟則可免填）。
   - `GEMINI_MODEL`：（選填）預設為 `gemini-3.5-flash-lite`。

---

## 🚀 怎麼跑（啟動與使用）

### 第一步：啟動本機轉接站

在終端機（如 PowerShell 或 Terminal）進入專案資料夾，執行：

```powershell
node line-search-relay.mjs
```

- 啟動後程式會：
  1. 將模型預載至顯示卡（GPU）。
  2. 生成金鑰並儲存在本機家目錄（`~/.line-search-relay.key`），同時**自動複製至系統剪貼簿**。
  3. 啟動 Cloudflare Tunnel，並在終端機輸出對外公開網址（例如 `https://xxxx.trycloudflare.com`）。
- **更新屬性**：將終端機顯示的網址填入 Apps Script 的 `SEARCH_RELAY_URL`，剪貼簿內的密碼貼入 `SEARCH_RELAY_KEY`。

> 💡 *本機除錯模式*：若只需本機測試不開對外通道，可執行 `node line-search-relay.mjs --no-tunnel`。

### 第二步：部署 Apps Script Web 應用程式

1. 在 Apps Script 編輯器右上角點選「**部署** → **新增部署作業**」。
2. 種類選擇「**網路應用程式**」：
   - 執行身分：**我**
   - 誰可以存取：**所有人**
3. 部署完成後複製「**網頁應用程式網址**」（結尾為 `/exec`）。
4. 前往 [LINE Developers Console](https://developers.line.biz/)，進入 Messaging API 設定頁：
   - 將 Webhook URL 設定為上述的 Apps Script 網址。
   - 開啟 **Use webhook**。
   - 關閉 LINE 官方的「自動回應訊息」。

### 第三步：測試連線與功能

1. **自我檢查**：在 Apps Script 函式下拉選單中選擇 `testSetup` 並執行，確認 LINE token、日曆、Gemini、試算表及轉接站皆回傳 `✅`。
2. **在 LINE 對話視窗測試**：
   - **聯網查詢**（走本機轉接站＋即時搜尋，不進試算表）：
     - `查 明天台北天氣如何？`
     - `搜尋 2026 最新 AI 科技新聞`
   - **待辦事項**（走雲端 Gemini，寫入試算表與日曆）：
     - `明天下午三點要跟團隊開會`
     - 或直接傳送一張活動海報、收據照片。

---

## 🔧 你改了什麼（變更紀錄）

相較於先前的 Level 2 待辦小秘書版本，本次新增了**本地搜尋轉接站整合**，主要修改項目如下：

1. **指令碼屬性設定擴充**：
   - 新增 `SEARCH_RELAY_URL` 與 `SEARCH_RELAY_KEY` 的讀取，確保網址與金鑰不寫死在程式碼中。

2. **訊息前綴識別與智慧分流**：
   - 在 `handleEvent` 加入以正規表達式判斷 `^(?:查|搜尋)`：
     - 若使用者輸入「查 …」或「搜尋 …」，提取其問題關鍵字，顯示 LINE 輸入中動畫（`showLoading`），並導向 `handleSearchQuery`。
     - 原始的待辦事項分析、日曆排程、打招呼、照片存 Drive 等功能完整保留，互不干擾。

3. **實作轉接站通訊模組（`handleSearchQuery`）**：
   - 使用 `UrlFetchApp.fetch` 發送 `POST` 請求至 `${SEARCH_RELAY_URL}/ask`。
   - 加入 `x-relay-key` 自訂標頭進行驗證，Payload 格式為 `{"question": "問題"}`。
   - 解析轉接站回傳的 JSON：
     - 取出 `answer` 作為文字主體。
     - 若附帶 `sources`（搜尋來源），格式化為標題與連結清單附加在訊息末尾。
   - **完全不寫入 Google 試算表**，維持純問答機制。

4. **斷線與容錯防護**：
   - 若轉接站未連線、逾時、服務未開或回傳非 200 代碼，老實向使用者回覆：**「現在連不到我的電腦」**。
   - **堅決不改問 Gemini**，避免破壞預期行為或產生非預期費用。

5. **自我測試（`testSetup`）升級**：
   - 新增轉接站連線檢測，透過 `GET /check-key` 驗證金鑰與通道狀態，方便部署前一鍵診斷。
