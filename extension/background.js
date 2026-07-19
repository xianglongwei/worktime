const API_ORIGIN = "https://yunchuang.talkweb.com.cn";
const ATTENDANCE_PATH = "/attendance/human/rzAttendanceinfo/listByMonth";
const LOGIN_URL = `${API_ORIGIN}/dashboard/analysis`;
const CACHE_PREFIX = "attendance:";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "YUNCHUANG_AUTH_SNAPSHOT") {
    saveAuthSnapshot(message.auth).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "GET_ATTENDANCE") {
    getAttendance(message.yearMonth, Boolean(message.force))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "OPEN_LOGIN") {
    chrome.tabs.create({ url: LOGIN_URL });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function getAttendance(yearMonth, force) {
  if (!/^\d{6}$/.test(yearMonth || "")) {
    throw new Error("月份格式无效，应为 YYYYMM。");
  }

  const cacheKey = `${CACHE_PREFIX}${yearMonth}`;
  if (!force) {
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached[cacheKey]?.payload) {
      return { ...cached[cacheKey], fromCache: true };
    }
  }

  const url = new URL(`${API_ORIGIN}${ATTENDANCE_PATH}`);
  url.searchParams.set("_t", String(Math.floor(Date.now() / 1000)));
  url.searchParams.set("yearMonth", yearMonth);

  await refreshAuthFromOpenTabs();
  const auth = await getStoredAuth();
  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Accept": "application/json, text/plain, */*",
      ...(auth?.headers || {})
    }
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("没有拿到 JSON 数据，可能登录已失效，请先打开云创页面登录。");
  }

  if (!response.ok || payload?.code === 401 || payload?.code === 403 || payload?.success === false) {
    const keys = auth?.foundKeys?.length ? `已捕获鉴权字段：${auth.foundKeys.join(", ")}` : "未捕获页面 token";
    throw new Error(`${payload?.message || `请求失败：HTTP ${response.status}`}。${keys}。请打开云创页面后点刷新。`);
  }

  const stored = {
    yearMonth,
    fetchedAt: new Date().toISOString(),
    payload
  };
  await chrome.storage.local.set({ [cacheKey]: stored });
  return { ...stored, fromCache: false };
}

async function saveAuthSnapshot(auth) {
  if (!auth?.headers || Object.keys(auth.headers).length === 0) return;
  await chrome.storage.local.set({ yunchuangAuth: auth });
}

async function getStoredAuth() {
  const stored = await chrome.storage.local.get("yunchuangAuth");
  return stored.yunchuangAuth || null;
}

async function refreshAuthFromOpenTabs() {
  const tabs = await chrome.tabs.query({ url: "https://yunchuang.talkweb.com.cn/*" });
  await Promise.allSettled(tabs.map((tab) => (
    chrome.tabs.sendMessage(tab.id, { type: "COLLECT_YUNCHUANG_AUTH" })
      .then(saveAuthSnapshot)
  )));
}
