const API_ORIGINS = [
  "https://yunchuang.talkweb.com.cn",
  "https://yunchuangwq.talkweb.com.cn",
  "https://yunchuanghq.talkweb.com.cn"
];
const ATTENDANCE_PATH = "/attendance/human/rzAttendanceinfo/listByMonth";
const LOGIN_PATH = "/dashboard/analysis";
const CAPTCHA_PATH = "/auth/sys/randomImage";
const LOGIN_API_PATH = "/auth/sys/login";
const CACHE_PREFIX = "attendance:";
const KEEPALIVE_ALARM = "yunchuang-keepalive";
const KEEPALIVE_PERIOD_MINUTES = 30;
// 自动登录时验证码识别可能偶尔出错，失败就换一张重试，最多这么多次
const MAX_LOGIN_ATTEMPTS = 8;

// 定时保活：静默请求一次接口，保持当月缓存新鲜。token 是固定 12 小时
// JWT，保活不能续期；过期后由 autoLogin（存好的账号密码 + 本地验证码
// 识别）静默自动登录。全程不开任何页面。
chrome.runtime.onInstalled.addListener(scheduleKeepAlive);
chrome.runtime.onStartup.addListener(() => {
  scheduleKeepAlive();
  keepAlive();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) keepAlive();
});

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
    getApiOrigin().then((origin) => chrome.tabs.create({ url: `${origin}${LOGIN_PATH}` }));
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "AUTO_LOGIN_NOW") {
    // 供 popup 的“测试登录”按钮调用
    autoLogin()
      .then((auth) => sendResponse({
        ok: Boolean(auth),
        error: auth ? null : "自动登录未成功（验证码识别或账号密码问题），请查看后台日志。"
      }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
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

  await refreshAuthFromOpenTabs();
  let auth = await getStoredAuth();
  let result = await tryFetchAttendance(yearMonth, auth);

  if (result.authFailed) {
    // token 已过期（固定 12 小时）：用存好的账号密码 + 本地验证码识别
    // 静默自动登录，全程无需手动操作。
    // 重试循环：autoLogin 成功后 tryFetchAttendance 仍可能 authFailed
    // （token 被其他会话顶掉等），最多再重试 2 次（总共 3 次尝试）。
    const maxLoginRetries = 3;
    let lastFetchError = null;
    for (let loginAttempt = 0; loginAttempt < maxLoginRetries; loginAttempt++) {
      console.log(`[考勤插件] 第 ${loginAttempt + 1}/${maxLoginRetries} 次自动登录+获取数据尝试...`);
      auth = await autoLogin();
      if (!auth) break;
      try {
        result = await tryFetchAttendance(yearMonth, auth);
        lastFetchError = null;
      } catch (error) {
        lastFetchError = error;
        result = { authFailed: true };
        console.warn(`[考勤插件] 第 ${loginAttempt + 1} 次获取考勤数据抛错：${error.message}`);
      }
      if (!result.authFailed) break;
      console.warn(`[考勤插件] 自动登录成功但考勤数据获取仍失败（authFailed），准备重试...`);
    }
    // 将最后一次 fetch 错误保留，供下方错误处理使用
    if (lastFetchError && result.authFailed) {
      result.fetchError = lastFetchError;
    }
  }
  
  if (result.authFailed) {
    const creds = await getStoredCreds();
    const configured = Boolean(creds?.username && creds?.password && creds?.autoLogin);
    if (auth) {
      // 登录成功了但数据获取失败，区分两种情况：
      // 1. tryFetchAttendance 抛错（网络异常/接口返回非预期格式）
      // 2. tryFetchAttendance 返回 authFailed（token 被其他会话顶掉）
      if (result.fetchError) {
        console.warn(`[考勤插件] 自动登录成功但考勤接口抛错：${result.fetchError.message}`);
        throw new Error(`自动登录成功但考勤接口返回异常：${result.fetchError.message}，请稍后重试。`);
      }
      console.warn("[考勤插件] 自动登录成功但考勤接口返回认证失败（authFailed），token 可能被其他会话顶掉。");
      throw new Error("自动登录成功但考勤接口仍返回认证失败，可能 token 被其他登录会话顶掉。请关闭其他云创页面后重试。");
    }
    console.warn(configured
      ? "[考勤插件] 自动登录未成功：验证码多次识别失败或账号密码有误。"
      : `[考勤插件] 未配置后台自动登录（缺少工号/密码，或未勾选「启用后台自动登录」）。`);
    throw new Error(configured
      ? "自动登录未成功（验证码多次识别失败或账号密码有误），请在插件设置里检查账号密码，或点「打开云创」手动登录一次。"
      : `未开启自动登录。请点右上角 ⚙ 填写工号密码并勾选「启用后台自动登录」，或点「打开云创」手动登录一次。`);
  }

  const stored = {
    yearMonth,
    fetchedAt: new Date().toISOString(),
    payload: result.payload
  };
  await chrome.storage.local.set({ [cacheKey]: stored });
  return { ...stored, fromCache: false };
}

// 请求 + 解析；登录过期返回 { authFailed: true }，其他错误直接抛出。
async function tryFetchAttendance(yearMonth, auth) {
  const { response, text } = await fetchAttendance(yearMonth, auth);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    // 实测：token 失效时接口返回 401 + 空响应体（非 JSON）
    if (response.status === 401 || response.status === 403) {
      console.warn(`[考勤插件] 考勤接口返回认证失败：HTTP ${response.status}，响应：${text?.slice(0, 200) || '(空)'}`);
      return { authFailed: true };
    }
    throw new Error("没有拿到 JSON 数据，请打开云创页面登录后再刷新。");
  }

  if (response.status === 401 || response.status === 403 || payload?.code === 401 || payload?.code === 403) {
    console.warn(`[考勤插件] 考勤接口业务码认证失败：code=${payload?.code || 'N/A'}，HTTP ${response.status}`);
    return { authFailed: true };
  }

  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.message || `请求失败：HTTP ${response.status}`);
  }

  return { payload };
}

// 静默自动登录（单飞）：同一时刻只允许一个登录流程。并发调用共享同一次
// 登录结果，避免两次登录互相把对方 token 顶掉（云创后端单会话，后登录会
// 使先前 token 失效，导致“登录成功却仍 401”）。
let autoLoginInFlight = null;
function autoLogin() {
  if (autoLoginInFlight) return autoLoginInFlight;
  autoLoginInFlight = runAutoLogin().finally(() => {
    autoLoginInFlight = null;
  });
  return autoLoginInFlight;
}

// 用存好的工号/密码 + 本地 OCR 识别图形验证码，直接 POST /auth/sys/login
// 获取新 token。验证码识别错就换一张重试。未配置账号或未开启自动登录时返回 null。
async function runAutoLogin() {
  const creds = await getStoredCreds();
  if (!creds?.username || !creds?.password || !creds.autoLogin) {
    return null;
  }

  const origin = await getApiOrigin();
  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt += 1) {
    const checkKey = Date.now();
    let captcha;
    try {
      const image = await fetchCaptcha(origin, checkKey);
      captcha = await recognizeCaptcha(image);
    } catch (error) {
      console.warn(`[考勤插件] 第 ${attempt} 次验证码获取/识别失败：`, error);
      continue;
    }

    if (!captcha || captcha.length < 4) {
      console.log(`[考勤插件] 第 ${attempt} 次验证码识别不足 4 位（${captcha || "空"}），换一张重试。`);
      continue;
    }

    const login = await submitLogin(origin, creds, captcha.slice(0, 4), checkKey);
    if (login.token) {
      const auth = {
        headers: { Authorization: `Bearer ${login.token}` },
        foundKeys: ["autologin"],
        capturedAt: new Date().toISOString()
      };
      await saveAuthSnapshot(auth);
      console.log(`[考勤插件] 自动登录成功（第 ${attempt} 次），已获取新 token。`);
      return auth;
    }

    if (login.captchaError) {
      console.log(`[考勤插件] 第 ${attempt} 次验证码错误（识别为 ${captcha.slice(0, 4)}），换一张重试。`);
      continue;
    }

    // 非验证码错误（账号/密码错等），重试也无用，直接报错。
    throw new Error(login.message || "自动登录失败：账号或密码可能有误。");
  }

  console.warn("[考勤插件] 自动登录：验证码多次识别未通过。");
  return null;
}

// 获取图形验证码（返回 data:image base64），checkKey 与登录请求必须一致。
async function fetchCaptcha(origin, checkKey) {
  const url = `${origin}${CAPTCHA_PATH}/${checkKey}?_t=${Math.floor(checkKey / 1000)}`;
  const response = await fetch(url, {
    credentials: "include",
    headers: { "Accept": "application/json, text/plain, */*" }
  });
  const json = await response.json();
  if (!json?.result || typeof json.result !== "string") {
    throw new Error("验证码接口返回异常。");
  }
  return json.result;
}

// 投递登录：成功返回 { token }；验证码错返回 { captchaError: true }。
async function submitLogin(origin, creds, captcha, checkKey) {
  const cookieHeader = await getCookieHeader(origin);
  const response = await fetch(`${origin}${LOGIN_API_PATH}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/plain, */*",
      ...(cookieHeader ? { "Cookie": cookieHeader } : {})
    },
    body: JSON.stringify({
      username: creds.username,
      password: creds.password,
      captcha,
      checkKey,
      remember_me: true
    })
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 非 JSON（例如 401 空体），当作非验证码错误处理
    return { message: `登录接口异常：HTTP ${response.status}` };
  }

  if (json?.success && json?.result?.token) {
    // 登录 API 返回的 token 可能已含 "Bearer " 前缀，剥离以避免双重前缀
    const rawToken = json.result.token;
    const token = rawToken.startsWith("Bearer ") ? rawToken.slice(7) : rawToken;
    return { token };
  }
  const message = json?.message || "";
  const captchaError = json?.code === 412 || /验证码/.test(message);
  return { captchaError, message };
}

// 通过离屏文档调用 Tesseract.js 本地识别验证码。
async function recognizeCaptcha(dataUrl) {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({
    type: "OCR_CAPTCHA",
    target: "offscreen",
    dataUrl
  });
  if (!response?.ok) {
    throw new Error(response?.error || "验证码识别失败。");
  }
  return response.text;
}

let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "在本地离线识别云创登录图形验证码（Tesseract.js），用于自动续期登录态。"
    });
  }
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function getStoredCreds() {
  const stored = await chrome.storage.local.get("loginCreds");
  return stored.loginCreds || null;
}

// 获取目标域名的所有 cookies，构造 Cookie 请求头字符串。
// service worker 的 fetch 不一定能自动带上目标域的 cookies，
// 所以通过 chrome.cookies API 显式获取并拼接到请求头中。
async function getCookieHeader(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (cookies.length === 0) return "";
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

// 通过已打开的云创页面的 content script 发起请求。
// content script 运行在页面上下文中，能利用页面的 cookie jar 和请求上下文，
// 解决 service worker fetch 无法正确携带认证信息的问题。
// cookie（含 HttpOnly）由本函数通过 chrome.cookies.getAll 获取并放入 authHeaders，
// content script 只负责发请求和返回响应体。
async function fetchViaContentScript(url, authHeaders) {
  const tabs = await chrome.tabs.query({
    url: API_ORIGINS.map((origin) => `${origin}/*`)
  });
  console.log(`[考勤插件] fetchViaContentScript：找到 ${tabs.length} 个云创标签页`);
  if (tabs.length === 0) {
    console.log("[考勤插件] fetchViaContentScript：无可用云创标签页，跳过 content script 通道");
    return null;
  }

  // 通过 chrome.cookies 获取目标域全量 cookie（含 HttpOnly），
  // 这是解决 401 的关键——session cookie 通常是 HttpOnly 的。
  let cookieHeader = "";
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (cookies.length > 0) {
      cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    }
  } catch { /* 权限不足时静默跳过 */ }
  if (!cookieHeader) {
    console.warn(`[考勤插件] fetchViaContentScript：chrome.cookies.getAll 未获取到 cookie（url=${url}），content script 请求可能因缺少认证 cookie 而失败`);
  }

  // 合并 Authorization + Cookie 到请求头
  const mergedHeaders = { ...(authHeaders || {}) };
  if (cookieHeader) {
    mergedHeaders.Cookie = cookieHeader;
  }

  let allFailed = true;
  for (const tab of tabs) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: "FETCH_ATTENDANCE",
        url,
        authHeaders: mergedHeaders
      });
      if (response?.ok) {
        allFailed = false;
        return response;
      }
      console.warn(`[考勤插件] fetchViaContentScript：tab ${tab.id} 返回非 ok 响应：${JSON.stringify(response)}`);
    } catch (error) {
      console.warn(`[考勤插件] fetchViaContentScript：tab ${tab.id} 消息发送失败：${error.message}`);
    }
  }
  if (allFailed) {
    console.log("[考勤插件] fetchViaContentScript：所有标签页均失败，回退到 service worker");
  }
  return null;
}

// 请求考勤接口；优先通过 content script 从页面上下文发起（依赖页面 cookie jar，
// 需要用户在浏览器中已手动登录云创），失败时回退到 service worker 直接 fetch。
// 注意：chrome.cookies.getAll 获取的 cookie 无法通过 fetch 的 Cookie header 传递
// （浏览器会静默丢弃 forbidden header），content script 通道依赖的是页面自身的
// cookie jar（credentials: "include"）。
async function fetchAttendance(yearMonth, auth) {
  const preferred = await getApiOrigin();
  const origins = [preferred, ...API_ORIGINS.filter((item) => item !== preferred)];

  for (const origin of origins) {
    const url = new URL(`${origin}${ATTENDANCE_PATH}`);
    url.searchParams.set("_t", String(Math.floor(Date.now() / 1000)));
    url.searchParams.set("yearMonth", yearMonth);

    // 优先通过 content script 从页面上下文发起请求
    const csResult = await fetchViaContentScript(url.toString(), auth?.headers || {});
    if (csResult) {
      const fakeResponse = { status: csResult.status, ok: csResult.status >= 200 && csResult.status < 300 };
      await chrome.storage.local.set({ apiOrigin: origin });
      return { response: fakeResponse, text: csResult.text };
    }
    console.log(`[考勤插件] content script 通道不可用，回退 service worker fetch：origin=${origin}`);

    // 回退：service worker 直接 fetch
    try {
      const cookieHeader = await getCookieHeader(origin);
      const response = await fetch(url.toString(), {
        credentials: "include",
        headers: {
          "Accept": "application/json, text/plain, */*",
          ...(auth?.headers || {}),
          ...(cookieHeader ? { "Cookie": cookieHeader } : {})
        }
      });
      const text = await response.text();
      await chrome.storage.local.set({ apiOrigin: origin });
      console.log(`[考勤插件] 考勤请求（via service worker）：origin=${origin}，HTTP ${response.status}`);
      return { response, text };
    } catch (error) {
      // fetch 抛错 = 域名不可达，换备用地址重试
    }
  }

  throw new Error("云创服务无法访问（主备地址均连接失败，且无可用云创页面）");
}

// 定时保活：静默刷新当月缓存。token 过期时用存好的账号密码 + 本地
// 验证码识别自动登录续期，这样“打开浏览器就有新鲜数据”，全程无页面。
async function keepAlive() {
  try {
    await refreshAuthFromOpenTabs();
    let auth = await getStoredAuth();
    const yearMonth = currentYearMonth();

    let result = auth && Object.keys(auth.headers || {}).length > 0
      ? await tryFetchAttendance(yearMonth, auth)
      : { authFailed: true };

    if (result.authFailed) {
      // 保护：如果最近 60 秒内已有 autoLogin 的 token，直接复用，
      // 避免 keepAlive 的 autoLogin 把 getAttendance 的 token 顶掉
      // （云创后端单会话，后登录使先前 token 失效）。
      const recentAuth = await getStoredAuth();
      const recentTs = recentAuth?.capturedAt ? new Date(recentAuth.capturedAt).getTime() : 0;
      if (recentAuth && Date.now() - recentTs < 60_000 && Object.keys(recentAuth.headers || {}).length > 0) {
        console.log("[考勤插件] keepAlive：检测到最近 60 秒内已有 autoLogin token，跳过重复登录，复用已有 token。");
        auth = recentAuth;
      } else {
        auth = await autoLogin();
      }
      if (!auth) return; // 未配置账号或自动登录关闭，静默跳过
      result = await tryFetchAttendance(yearMonth, auth);
    }

    if (result.payload) {
      const fetchedAt = new Date().toISOString();
      await chrome.storage.local.set({
        [`${CACHE_PREFIX}${yearMonth}`]: { yearMonth, fetchedAt, payload: result.payload },
        lastAliveAt: fetchedAt
      });
    }
  } catch {
    // 网络不可用等，静默跳过本轮保活
  }
}

function scheduleKeepAlive() {
  chrome.alarms.create(KEEPALIVE_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: KEEPALIVE_PERIOD_MINUTES
  });
}

async function getApiOrigin() {
  const stored = await chrome.storage.local.get("apiOrigin");
  return API_ORIGINS.includes(stored.apiOrigin) ? stored.apiOrigin : API_ORIGINS[0];
}

function currentYearMonth() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
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
  const tabs = await chrome.tabs.query({
    url: API_ORIGINS.map((origin) => `${origin}/*`)
  });
  await Promise.allSettled(tabs.map((tab) => (
    chrome.tabs.sendMessage(tab.id, { type: "COLLECT_YUNCHUANG_AUTH" })
      .then(saveAuthSnapshot)
  )));
}
