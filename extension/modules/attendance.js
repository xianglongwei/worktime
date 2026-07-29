/**
 * 考勤数据模块：数据获取、缓存、多域名降级、保活
 */
import { API_ORIGINS, ATTENDANCE_PATH, CACHE_PREFIX, KEEPALIVE_ALARM, KEEPALIVE_PERIOD_MINUTES } from "./config.js";
import { currentYearMonth, getCookieHeader, log, warn, debug } from "./utils.js";
import { autoLogin, getStoredAuth, getStoredCreds, refreshAuthFromOpenTabs, getApiOrigin } from "./auth.js";

// ─── 考勤数据获取（主入口） ──────────────────────────────────

export async function getAttendance(yearMonth, force) {
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
    const maxLoginRetries = 3;
    let lastFetchError = null;
    for (let loginAttempt = 0; loginAttempt < maxLoginRetries; loginAttempt++) {
      debug(`第 ${loginAttempt + 1}/${maxLoginRetries} 次自动登录+获取数据尝试...`);
      auth = await autoLogin();
      if (!auth) break;
      try {
        result = await tryFetchAttendance(yearMonth, auth);
        lastFetchError = null;
      } catch (error) {
        lastFetchError = error;
        result = { authFailed: true };
        warn(`第 ${loginAttempt + 1} 次获取考勤数据抛错：${error.message}`);
      }
      if (!result.authFailed) break;
      warn("自动登录成功但考勤数据获取仍失败（authFailed），准备重试...");
    }
    if (lastFetchError && result.authFailed) {
      result.fetchError = lastFetchError;
    }
  }

  if (result.authFailed) {
    const creds = await getStoredCreds();
    const configured = Boolean(creds?.username && creds?.password && creds?.autoLogin);
    if (auth) {
      if (result.fetchError) {
        warn(`自动登录成功但考勤接口抛错：${result.fetchError.message}`);
        throw new Error(`自动登录成功但考勤接口返回异常：${result.fetchError.message}，请稍后重试。`);
      }
      warn("自动登录成功但考勤接口返回认证失败（authFailed），token 可能被其他会话顶掉。");
      throw new Error("自动登录成功但考勤接口仍返回认证失败，可能 token 被其他登录会话顶掉。请关闭其他云创页面后重试。");
    }
    warn(configured
      ? "自动登录未成功：验证码多次识别失败或账号密码有误。"
      : "未配置后台自动登录（缺少工号/密码，或未勾选「启用后台自动登录」）。");
    throw new Error(configured
      ? "自动登录未成功（验证码多次识别失败或账号密码有误），请在插件设置里检查账号密码，或点「打开云创」手动登录一次。"
      : "未开启自动登录。请点右上角 ⚙ 填写工号密码并勾选「启用后台自动登录」，或点「打开云创」手动登录一次。");
  }

  const stored = {
    yearMonth,
    fetchedAt: new Date().toISOString(),
    payload: result.payload
  };
  await chrome.storage.local.set({ [cacheKey]: stored });
  return { ...stored, fromCache: false };
}

// ─── 请求 + 解析 ────────────────────────────────────────────

export async function tryFetchAttendance(yearMonth, auth) {
  const { response, text } = await fetchAttendance(yearMonth, auth);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    if (response.status === 401 || response.status === 403) {
      warn(`考勤接口返回认证失败：HTTP ${response.status}，响应：${text?.slice(0, 200) || "(空)"}`);
      return { authFailed: true };
    }
    throw new Error("没有拿到 JSON 数据，请打开云创页面登录后再刷新。");
  }

  if (response.status === 401 || response.status === 403 || payload?.code === 401 || payload?.code === 403) {
    warn(`考勤接口业务码认证失败：code=${payload?.code || "N/A"}，HTTP ${response.status}`);
    return { authFailed: true };
  }

  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.message || `请求失败：HTTP ${response.status}`);
  }

  return { payload };
}

// ─── 网络请求（多通道 + 多域名降级） ─────────────────────────

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
    debug(`content script 通道不可用，回退 service worker fetch：origin=${origin}`);

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
      debug(`考勤请求（via service worker）：origin=${origin}，HTTP ${response.status}`);
      return { response, text };
    } catch {
      // fetch 抛错 = 域名不可达，换备用地址重试
    }
  }

  throw new Error("云创服务无法访问（主备地址均连接失败，且无可用云创页面）");
}

async function fetchViaContentScript(url, authHeaders) {
  const tabs = await chrome.tabs.query({
    url: API_ORIGINS.map((origin) => `${origin}/*`)
  });
  debug(`fetchViaContentScript：找到 ${tabs.length} 个云创标签页`);
  if (tabs.length === 0) return null;

  let cookieHeader = "";
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (cookies.length > 0) {
      cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    }
  } catch { /* 权限不足时静默跳过 */ }

  const mergedHeaders = { ...(authHeaders || {}) };
  if (cookieHeader) {
    mergedHeaders.Cookie = cookieHeader;
  }

  for (const tab of tabs) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: "FETCH_ATTENDANCE",
        url,
        authHeaders: mergedHeaders
      });
      if (response?.ok) return response;
      debug(`fetchViaContentScript：tab ${tab.id} 返回非 ok 响应`);
    } catch (error) {
      debug(`fetchViaContentScript：tab ${tab.id} 消息发送失败：${error.message}`);
    }
  }
  return null;
}

// ─── 定时保活 ────────────────────────────────────────────────

export async function keepAlive() {
  try {
    await refreshAuthFromOpenTabs();
    let auth = await getStoredAuth();
    const yearMonth = currentYearMonth();

    let result = auth && Object.keys(auth.headers || {}).length > 0
      ? await tryFetchAttendance(yearMonth, auth)
      : { authFailed: true };

    if (result.authFailed) {
      const recentAuth = await getStoredAuth();
      const recentTs = recentAuth?.capturedAt ? new Date(recentAuth.capturedAt).getTime() : 0;
      if (recentAuth && Date.now() - recentTs < 60_000 && Object.keys(recentAuth.headers || {}).length > 0) {
        debug("keepAlive：检测到最近 60 秒内已有 autoLogin token，跳过重复登录。");
        auth = recentAuth;
      } else {
        auth = await autoLogin();
      }
      if (!auth) return;
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

export function scheduleKeepAlive() {
  chrome.alarms.create(KEEPALIVE_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: KEEPALIVE_PERIOD_MINUTES
  });
}
