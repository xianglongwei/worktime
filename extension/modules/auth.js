/**
 * 认证模块：token 管理、自动登录、验证码 OCR
 */
import { API_ORIGINS, CAPTCHA_PATH, LOGIN_API_PATH, MAX_LOGIN_ATTEMPTS } from "./config.js";
import { getCookieHeader, log, warn, debug } from "./utils.js";

// ─── Storage 读写 ───────────────────────────────────────────

export async function getStoredCreds() {
  const stored = await chrome.storage.local.get("loginCreds");
  return stored.loginCreds || null;
}

export async function saveAuthSnapshot(auth) {
  if (!auth?.headers || Object.keys(auth.headers).length === 0) return;
  await chrome.storage.local.set({ yunchuangAuth: auth });
}

export async function getStoredAuth() {
  const stored = await chrome.storage.local.get("yunchuangAuth");
  return stored.yunchuangAuth || null;
}

export async function refreshAuthFromOpenTabs() {
  const tabs = await chrome.tabs.query({
    url: API_ORIGINS.map((origin) => `${origin}/*`)
  });
  await Promise.allSettled(tabs.map((tab) => (
    chrome.tabs.sendMessage(tab.id, { type: "COLLECT_YUNCHUANG_AUTH" })
      .then(saveAuthSnapshot)
  )));
}

// ─── 自动登录（单飞 + 超时保护） ─────────────────────────────

let autoLoginInFlight = null;

const AUTO_LOGIN_TIMEOUT_MS = 60_000;

export function autoLogin() {
  if (autoLoginInFlight) return autoLoginInFlight;
  autoLoginInFlight = Promise.race([
    runAutoLogin(),
    new Promise((resolve) => setTimeout(() => {
      warn("自动登录超时（60s），放弃本轮。");
      resolve(null);
    }, AUTO_LOGIN_TIMEOUT_MS))
  ]).finally(() => {
    autoLoginInFlight = null;
  });
  return autoLoginInFlight;
}

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
      warn(`第 ${attempt} 次验证码获取/识别失败：`, error);
      continue;
    }

    if (!captcha || captcha.length < 4) {
      debug(`第 ${attempt} 次验证码识别不足 4 位（${captcha || "空"}），换一张重试。`);
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
      log(`自动登录成功（第 ${attempt} 次），已获取新 token。`);
      return auth;
    }

    if (login.captchaError) {
      debug(`第 ${attempt} 次验证码错误（识别为 ${captcha.slice(0, 4)}），换一张重试。`);
      continue;
    }

    // 非验证码错误（账号/密码错等），重试也无用，直接报错。
    throw new Error(login.message || "自动登录失败：账号或密码可能有误。");
  }

  warn("自动登录：验证码多次识别未通过。");
  return null;
}

// ─── 验证码获取与识别 ────────────────────────────────────────

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

/** 通过离屏文档调用 Tesseract.js 本地识别验证码，识别完毕后关闭离屏文档释放资源 */
async function recognizeCaptcha(dataUrl) {
  await ensureOffscreen();
  try {
    const response = await chrome.runtime.sendMessage({
      type: "OCR_CAPTCHA",
      target: "offscreen",
      dataUrl
    });
    if (!response?.ok) {
      throw new Error(response?.error || "验证码识别失败。");
    }
    return response.text;
  } finally {
    // 识别完毕关闭离屏文档，避免资源泄漏
    await chrome.offscreen.closeDocument().catch(() => {});
  }
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

// ─── API Origin 管理 ─────────────────────────────────────────

export async function getApiOrigin() {
  const stored = await chrome.storage.local.get("apiOrigin");
  return API_ORIGINS.includes(stored.apiOrigin) ? stored.apiOrigin : API_ORIGINS[0];
}
