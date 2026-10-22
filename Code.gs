/**
 * LINE AI 待辦小秘書（Level 2：文字＋照片）
 *
 * 這份是正本：老師的示範 bot、學生 Level 2 的對照答案，都以這份為準。
 * 一則訊息的旅程：
 *   LINE 送來訊息 → 請 Gemini 把口語整理成固定欄位 → 程式驗算欄位
 *   → 寫進試算表 → 回覆 LINE（只講已經做完的事）→ 排 Google 日曆，結果寫回試算表
 *
 * 金鑰不寫在程式裡，一律放「專案設定 → 指令碼屬性」：
 *   GEMINI_API_KEY             必填，到 Google AI Studio 申請
 *   LINE_CHANNEL_ACCESS_TOKEN  必填，LINE Developers 後台發的長效 token
 *   SHEET_ID                   選填，程式不是從試算表「擴充功能 → Apps Script」開的才要填
 *   GEMINI_MODEL               選填，模型停用或想換模型時改這裡，不用動程式
 *   SEARCH_RELAY_URL           選填，本地搜尋轉接站網址（如 Cloudflare Tunnel 網址）
 *   SEARCH_RELAY_KEY           選填，本地搜尋轉接站密碼
 */

// ===== 1. 設定 =====
const PROPS = PropertiesService.getScriptProperties();
const GEMINI_API_KEY = PROPS.getProperty("GEMINI_API_KEY") || "";
const LINE_ACCESS_TOKEN = PROPS.getProperty("LINE_CHANNEL_ACCESS_TOKEN") || "";
const SHEET_ID = PROPS.getProperty("SHEET_ID") || "";
// 模型名稱會隨 Google 改版而停用：上課前到 https://ai.google.dev/gemini-api/docs/models 確認還在
const GEMINI_MODEL = PROPS.getProperty("GEMINI_MODEL") || "gemini-3.5-flash-lite";
const SEARCH_RELAY_URL = PROPS.getProperty("SEARCH_RELAY_URL") || "";
const SEARCH_RELAY_KEY = PROPS.getProperty("SEARCH_RELAY_KEY") || "";
const TZ = "Asia/Taipei";
const CATEGORIES = ["繳費", "會議", "課業", "生活", "其他"];
const HEADERS = ["建立時間", "事項", "分類", "日期", "時間", "來源", "日曆", "照片連結"];
const GREETING = /^(hi|hello|hey|你好|嗨|哈囉|安安|早安|午安|晚安|謝謝|感謝|ok|好的|掰|bye|test|測試)$/i;
const HELP_TEXT = "你好！我是你的 AI 待辦小秘書 🤖\n\n直接傳給我：\n•「明天下午三點要開會」\n•「週五前記得繳房租」\n• 或拍一張活動海報、便條紙\n\n我會記進試算表；有日期和時間的，再幫你排進 Google 日曆。";


// ===== 2. LINE 送訊息進來的入口 =====
function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    // 在 LINE 後台按 Verify 時，送來的 events 是空的，這裡就什麼都不做
    (body.events || []).forEach(handleEvent);
  } catch (err) {
    console.error("讀不懂 LINE 送來的內容：", err);
  }
  return ContentService.createTextOutput("OK");
}

// 用瀏覽器打開 /exec 網址會看到這行字，可以確認部署成功
function doGet() {
  return ContentService.createTextOutput("LINE AI 待辦小秘書運作中（Level 2）");
}

// 一次處理一則訊息；其中一則出錯，不影響同一批的其他訊息
function handleEvent(event) {
  if (event.type !== "message" || !event.replyToken) return;
  try {
    const msg = event.message;
    if (msg.type === "text") {
      const text = msg.text.trim();
      if (GREETING.test(text)) return replyLine(event.replyToken, HELP_TEXT);  // 打招呼不必問 AI，直接回

      // 檢查是否為搜尋指令（以「查」或「搜尋」開頭）
      const searchMatch = text.match(/^(?:查|搜尋)[:：\s]*(.*)$/);
      if (searchMatch) {
        const question = searchMatch[1].trim();
        if (!question) return replyLine(event.replyToken, "請在「查」或「搜尋」後面輸入你想問的問題喔！");
        showLoading(event.source);
        return handleSearchQuery(event.replyToken, question);
      }

      showLoading(event.source);
      return saveAndReply(event.replyToken, askGeminiAboutText(text), "文字");
    }
    if (msg.type === "image") {
      showLoading(event.source);
      const image = downloadLineImage(msg.id);
      const photoUrl = savePhotoToDrive(image);  // 先把照片存進 Drive，拿到連結
      return saveAndReply(event.replyToken, askGeminiAboutImage(image), "照片", photoUrl);
    }
    replyLine(event.replyToken, "目前我看得懂文字和照片，其他類型還不行喔。");
  } catch (err) {
    console.error("處理訊息失敗：", err);
    // 課堂版刻意把錯誤原因回給手機：學生可以整段貼給 AI，問它怎麼修
    try {
      replyLine(event.replyToken, "⚠️ 出錯了：" + err.message);
    } catch (err2) {
      console.error("連錯誤訊息都回不出去（多半是 LINE token 沒設定或貼錯）：", err2);
    }
  }
}


// ===== 2.1 轉接站查詢（不進試算表） =====
function handleSearchQuery(replyToken, question) {
  try {
    if (!SEARCH_RELAY_URL) throw new Error("未設定 SEARCH_RELAY_URL");
    const endpoint = SEARCH_RELAY_URL.replace(/\/+$/, "") + "/ask";
    const res = UrlFetchApp.fetch(endpoint, {
      method: "post",
      contentType: "application/json",
      headers: {
        "x-relay-key": SEARCH_RELAY_KEY
      },
      payload: JSON.stringify({ question: question }),
      muteHttpExceptions: true
    });

    if (res.getResponseCode() !== 200) {
      throw new Error(`轉接站狀態碼 ${res.getResponseCode()}`);
    }

    const data = JSON.parse(res.getContentText());
    let reply = data.answer || "（轉接站未回傳答案）";
    if (data.sources && Array.isArray(data.sources) && data.sources.length > 0) {
      const sourceLines = data.sources
        .filter(s => s && (s.title || s.url))
        .map(s => (s.title && s.url && s.title !== s.url) ? `• ${s.title}\n  ${s.url}` : `• ${s.url || s.title}`)
        .join("\n");
      if (sourceLines) {
        reply += "\n\n🔗 來源：\n" + sourceLines;
      }
    }
    replyLine(replyToken, reply);
  } catch (err) {
    console.error("呼叫轉接站失敗：", err);
    replyLine(replyToken, "現在連不到我的電腦");
  }
}


// ===== 3. 記錄、回覆、排日曆 =====
function saveAndReply(replyToken, todo, source, photoUrl) {
  if (!todo.isTodo) return replyLine(replyToken, todo.chatReply || HELP_TEXT);

  // ① 先寫進試算表：確定真的寫進去了，才能跟使用者說「記好了」
  const row = appendTodoRow(todo, source, photoUrl || "");
  const wantsCalendar = todo.date !== "未指定" && todo.time !== "未指定";

  // ② 回覆手機：只講已經做完的事（回覆碼要在收到訊息後 1 分鐘內用掉）
  let reply = `✅ 記好了（試算表第 ${row} 列）\n\n📌 ${todo.summary}\n🏷️ ${todo.category}\n📅 ${todo.date}　⏰ ${todo.time}`;
  reply += wantsCalendar
    ? "\n🗓️ 日曆提醒建立中，結果會寫在試算表的「日曆」欄"
    : "\nℹ️ 沒有明確的日期和時間，這筆先不排日曆";
  if (photoUrl) reply += "\n📷 照片已存進 Drive 的「LINE待辦照片」資料夾";
  replyLine(replyToken, reply);

  // ③ 最後才排日曆；成功或失敗都寫回試算表，不讓人誤以為做好了
  if (wantsCalendar) getSheet().getRange(row, 7).setValue(createCalendarEvent(todo));
}

function getSheet() {
  const ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error("找不到試算表：請從試算表的「擴充功能 → Apps Script」開程式，或在指令碼屬性填 SHEET_ID");
  const sheet = ss.getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold").setBackground("#0E7C7B").setFontColor("#FFFFFF");
  }
  return sheet;
}

function appendTodoRow(todo, source, photoUrl) {
  const sheet = getSheet();
  const now = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");
  // 全班同時傳訊息時，先排隊再寫，避免兩筆搶到同一列
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    sheet.appendRow([now, todo.summary, todo.category, todo.date, todo.time, source, "", photoUrl || ""]);
    return sheet.getLastRow();
  } finally {
    lock.releaseLock();
  }
}

// 照片先存進 Google Drive 的「LINE待辦照片」資料夾（沒有就建一個），回傳檔案連結
function savePhotoToDrive(blob) {
  const folderName = "LINE待辦照片";
  const found = DriveApp.getFoldersByName(folderName);
  const folder = found.hasNext() ? found.next() : DriveApp.createFolder(folderName);
  const stamp = Utilities.formatDate(new Date(), TZ, "yyyyMMdd-HHmmss");
  const file = folder.createFile(blob.setName("line-" + stamp + ".jpg"));
  return file.getUrl();
}

function createCalendarEvent(todo) {
  try {
    const start = new Date(`${todo.date}T${todo.time}:00+08:00`);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    const event = CalendarApp.getDefaultCalendar().createEvent(`【${todo.category}】${todo.summary}`, start, end, {
      description: "由 LINE AI 待辦小秘書建立"
    });
    event.addPopupReminder(30);
    return "已建立";
  } catch (err) {
    console.error("建立日曆失敗：", err);
    return "失敗：" + err.message;
  }
}


// ===== 4. 請 Gemini 把口語整理成固定欄位 =====
const JSON_SHAPE = `只輸出一個 JSON 物件，欄位固定如下：
{"isTodo": true 或 false,
 "summary": "事項，簡短一句",
 "category": "繳費、會議、課業、生活、其他 五選一",
 "date": "YYYY-MM-DD，沒提到就填 未指定",
 "time": "HH:mm（24 小時制），沒提到就填 未指定",
 "chatReply": "不是待辦時，給使用者的一句簡短回覆；是待辦就填空字串"}`;

// 附上星期幾，AI 才算得準「下週五」是哪一天
function nowText() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd EEEE HH:mm");
}

function askGeminiAboutText(text) {
  const prompt = `你是待辦事項助理。現在是台北時間 ${nowText()}。
判斷使用者這句話是不是待辦、提醒或行程。
是的話，把「明天」「下週五」這類說法換算成實際日期；不是的話，isTodo 填 false。
${JSON_SHAPE}
使用者說：${text}`;
  return checkTodo(callGemini([{ text: prompt }]));
}

function askGeminiAboutImage(blob) {
  const prompt = `你是待辦事項助理。現在是台北時間 ${nowText()}。
這是一張照片，可能是活動海報、便條紙或繳費單。找出上面最重要的一件待辦或活動。
照片上沒寫的欄位就填 未指定，不要自己猜。
${JSON_SHAPE}`;
  return checkTodo(callGemini([
    { text: prompt },
    { inlineData: { mimeType: blob.getContentType() || "image/jpeg", data: Utilities.base64Encode(blob.getBytes()) } }
  ]));
}

function callGemini(parts) {
  if (!GEMINI_API_KEY) throw new Error("還沒設定 GEMINI_API_KEY（專案設定 → 指令碼屬性）");
  const res = UrlFetchApp.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: "post",
    contentType: "application/json",
    headers: { "x-goog-api-key": GEMINI_API_KEY },  // 金鑰放標頭、不放網址，才不會留在各種紀錄裡
    payload: JSON.stringify({
      contents: [{ role: "user", parts: parts }],
      generationConfig: { responseMimeType: "application/json" }
    }),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code !== 200) throw new Error(`Gemini 回應 ${code}：${res.getContentText().slice(0, 150)}`);
  const data = JSON.parse(res.getContentText());
  const cand = (data.candidates || [])[0];
  const text = cand && cand.content && (cand.content.parts || []).map(p => p.text || "").join("");
  if (!text) throw new Error(`Gemini 沒有給內容（原因：${cand ? cand.finishReason : "沒有任何答案"}）`);
  return JSON.parse(text.replace(/^```(json)?\s*|\s*```$/g, ""));
}


// ===== 5. 驗算：AI 給的欄位不直接照單全收 =====
function checkTodo(t) {
  return {
    isTodo: t.isTodo === true,
    summary: String(t.summary || "").trim() || "（沒抓到事項）",
    category: CATEGORIES.includes(t.category) ? t.category : "其他",
    date: isRealDate(t.date) ? t.date : "未指定",
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(t.time) ? t.time : "未指定",
    chatReply: String(t.chatReply || "")
  };
}

// 「2026-02-30」格式對、日子卻不存在：轉成日期再轉回來，對得上才算數
function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00+08:00`);
  return !isNaN(d.getTime()) && Utilities.formatDate(d, TZ, "yyyy-MM-dd") === s;
}


// ===== 6. LINE 相關 =====
function lineApi(path, payload, host) {
  if (!LINE_ACCESS_TOKEN) throw new Error("還沒設定 LINE_CHANNEL_ACCESS_TOKEN（專案設定 → 指令碼屬性）");
  const options = {
    method: payload ? "post" : "get",
    headers: { Authorization: "Bearer " + LINE_ACCESS_TOKEN },
    muteHttpExceptions: true
  };
  if (payload) {
    options.contentType = "application/json";
    options.payload = JSON.stringify(payload);
  }
  return UrlFetchApp.fetch((host || "https://api.line.me") + path, options);
}

function replyLine(replyToken, text) {
  const res = lineApi("/v2/bot/message/reply", {
    replyToken: replyToken,
    messages: [{ type: "text", text: text.slice(0, 5000) }]
  });
  if (res.getResponseCode() !== 200) console.error("LINE 回覆失敗：", res.getResponseCode(), res.getContentText());
}

// 「對方正在輸入…」動畫：只有一對一聊天看得到，沒開成也不影響功能
function showLoading(source) {
  if (!source || source.type !== "user") return;
  try {
    lineApi("/v2/bot/chat/loading/start", { chatId: source.userId, loadingSeconds: 20 });
  } catch (err) {
    console.warn("輸入中動畫沒開成：", err);
  }
}

// 照片要到另一個網域（api-data）下載，而且 LINE 不會一直保存，收到就要抓
function downloadLineImage(messageId) {
  const res = lineApi(`/v2/bot/message/${messageId}/content`, null, "https://api-data.line.me");
  if (res.getResponseCode() !== 200) throw new Error(`照片下載失敗（LINE 回應 ${res.getResponseCode()}）`);
  const blob = res.getBlob();
  // 送給 Gemini 的請求有大小上限，照片轉成文字（Base64）還會再大三分之一，太大的先請使用者縮小
  if (blob.getBytes().length > 10 * 1024 * 1024) throw new Error("照片太大（超過 10 MB），請截圖或壓縮後再傳");
  return blob;
}


// ===== 7. 自我檢查：在編輯器上方選 testSetup，按「執行」 =====
function testSetup() {
  const results = [];
  const check = (name, fn) => {
    try {
      results.push(`✅ ${name}：${fn()}`);
    } catch (err) {
      results.push(`❌ ${name}：${err.message}`);
    }
  };
  check("LINE token", () => {
    const res = lineApi("/v2/bot/info");
    if (res.getResponseCode() !== 200) throw new Error(`LINE 回應 ${res.getResponseCode()}，token 可能貼錯或已經重發`);
    return "bot 名稱「" + JSON.parse(res.getContentText()).displayName + "」";
  });
  check("Google 日曆", () => "可以使用「" + CalendarApp.getDefaultCalendar().getName() + "」");
  let todo = null;
  check("Gemini", () => {
    todo = askGeminiAboutText("明天早上十點要交房租，記得轉帳給房東");
    return JSON.stringify(todo);
  });
  check("試算表", () => {
    if (!todo) throw new Error("Gemini 那關沒過，先不寫");
    return `寫進第 ${appendTodoRow(todo, "testSetup")} 列`;
  });
  check("轉接站 (選填)", () => {
    if (!SEARCH_RELAY_URL) return "未設定 SEARCH_RELAY_URL（略過）";
    const endpoint = SEARCH_RELAY_URL.replace(/\/+$/, "") + "/check-key";
    const res = UrlFetchApp.fetch(endpoint, {
      method: "get",
      headers: { "x-relay-key": SEARCH_RELAY_KEY },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) throw new Error(`HTTP ${res.getResponseCode()} ${res.getContentText()}`);
    return "連線成功（模型：" + JSON.parse(res.getContentText()).model + "）";
  });
  console.log(results.join("\n"));
  console.log("👉 打開試算表，親眼看到多了一列才算成功。出現權限錯誤，或這裡說成功、表裡卻沒有，多半是授權畫面沒有全部勾選。");
}