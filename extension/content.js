const TOKEN_KEY_PATTERNS = [
  /token/i,
  /authorization/i,
  /access/i,
  /x-access-token/i,
  /x_access_token/i
];

collectAuthSnapshot();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "COLLECT_YUNCHUANG_AUTH") {
    sendResponse(collectAuthSnapshot());
  }
});

function collectAuthSnapshot() {
  const candidates = [
    ...readStorage("localStorage", window.localStorage),
    ...readStorage("sessionStorage", window.sessionStorage)
  ];

  const auth = buildAuthHeaders(candidates);
  chrome.runtime.sendMessage({ type: "YUNCHUANG_AUTH_SNAPSHOT", auth }).catch(() => {});
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

  for (const item of safeCandidates) {
    const lowerKey = item.key.toLowerCase();
    if (lowerKey.includes("authorization")) {
      headers.Authorization = item.value.startsWith("Bearer ") ? item.value : `Bearer ${item.value}`;
    } else if (lowerKey.includes("access_token") || lowerKey.includes("x-access-token")) {
      if (item.value.startsWith("Bearer ")) {
        headers.Authorization = item.value;
      } else {
        headers["X-Access-Token"] = item.value;
      }
    } else if (lowerKey.includes("accesstoken") || lowerKey === "token") {
      headers["X-Access-Token"] = item.value.startsWith("Bearer ") ? item.value.slice(7) : item.value;
    }
  }

  if (!headers["X-Access-Token"] && !headers.Authorization && safeCandidates[0]) {
    if (safeCandidates[0].value.startsWith("Bearer ")) {
      headers.Authorization = safeCandidates[0].value;
    } else {
      headers["X-Access-Token"] = safeCandidates[0].value;
    }
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
