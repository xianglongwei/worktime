const TOKEN_KEY_PATTERNS = [
  /token/i,
  /authorization/i,
  /access/i,
  /x-access-token/i,
  /x_access_token/i
];
const EARLY_POLL_MS = 3000;
const EARLY_POLL_WINDOW_MS = 60000;

let lastSignature = "";

collectAuthSnapshot();

// 云创是 SPA，登录成功后 token 是异步写入 storage 的，
// 页面加载后的一段时间内轮询，确保能抓到登录后新签发的 token。
const pollStart = Date.now();
const pollTimer = setInterval(() => {
  collectAuthSnapshot();
  if (Date.now() - pollStart > EARLY_POLL_WINDOW_MS) clearInterval(pollTimer);
}, EARLY_POLL_MS);

window.addEventListener("focus", () => collectAuthSnapshot());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) collectAuthSnapshot();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "COLLECT_YUNCHUANG_AUTH") {
    sendResponse(collectAuthSnapshot());
    return;
  }

  if (message?.type === "FETCH_ATTENDANCE") {
    // 从页面上下文发起考勤 API 请求，利用页面的 cookie jar 和请求上下文。
    // cookie（含 HttpOnly）由 background 通过 chrome.cookies.getAll 获取并放入
    // authHeaders.Cookie，content script 只负责发请求和返回响应体。
    fetch(message.url, {
      method: "GET",
      credentials: "include",
      headers: {
        "Accept": "application/json, text/plain, */*",
        ...(message.authHeaders || {})
      }
    })
      .then(async (response) => {
        const text = await response.text();
        sendResponse({ ok: true, status: response.status, text });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message });
      });
    return true; // 保持消息通道异步
  }
});

function collectAuthSnapshot() {
  const candidates = [
    ...readStorage("localStorage", window.localStorage),
    ...readStorage("sessionStorage", window.sessionStorage)
  ];

  const auth = buildAuthHeaders(candidates);
  // token 没变化时不重复上报，避免轮询产生噪声
  const signature = JSON.stringify(auth.headers);
  if (signature !== lastSignature) {
    lastSignature = signature;
    chrome.runtime.sendMessage({ type: "YUNCHUANG_AUTH_SNAPSHOT", auth }).catch(() => {});
  }
  return auth;
}

function readStorage(source, storage) {
  const rows = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      const value = storage.getItem(key);
      if (!key || !value) continue;
      if (TOKEN_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
        rows.push({ source, key, value: unwrapValue(value) });
      }
    }
  } catch {
    // Some enterprise pages can restrict storage reads during redirects.
  }
  return rows;
}

function unwrapValue(value) {
  const trimmed = String(value).trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string") return parsed;
    if (parsed?.value && typeof parsed.value === "string") return parsed.value;
    if (parsed?.token && typeof parsed.token === "string") return parsed.token;
    if (parsed?.accessToken && typeof parsed.accessToken === "string") return parsed.accessToken;
  } catch {
    // Plain string token.
  }
  return trimmed;
}

function buildAuthHeaders(candidates) {
  const headers = {};
  const safeCandidates = candidates
    .filter((item) => item.value && item.value.length >= 8)
    .sort((a, b) => scoreKey(b.key) - scoreKey(a.key));

  // 实测验证：云创后端只接受 Authorization: Bearer <token>，
  // X-Access-Token 一律返回 401。
  const best = safeCandidates[0];
  if (best) {
    headers.Authorization = best.value.startsWith("Bearer ") ? best.value : `Bearer ${best.value}`;
  }

  return {
    headers,
    foundKeys: safeCandidates.map((item) => `${item.source}:${item.key}`),
    capturedAt: new Date().toISOString()
  };
}

function scoreKey(key) {
  const lower = key.toLowerCase();
  if (lower === "token") return 100;
  if (lower.includes("x-access-token")) return 90;
  if (lower.includes("access_token")) return 80;
  if (lower.includes("accesstoken")) return 80;
  if (lower.includes("authorization")) return 70;
  if (lower.includes("token")) return 60;
  return 0;
}
