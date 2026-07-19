let id = 0;
const pending = new Map();

function send(ws, method, params = {}) {
  const messageId = ++id;
  ws.send(JSON.stringify({ id: messageId, method, params }));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(messageId);
      reject(new Error(`${method} timeout`));
    }, 20000);
    pending.set(messageId, { resolve, reject, timeout });
  });
}

function wire(ws, onEvent) {
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const item = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(item.timeout);
      if (msg.error) item.reject(new Error(msg.error.message));
      else item.resolve(msg.result);
      return;
    }
    onEvent?.(msg);
  });
}

const tabs = await fetch("http://127.0.0.1:9222/json/list").then((res) => res.json());
const page = tabs.find((tab) => tab.type === "page" && tab.url.includes("yunchuang.talkweb.com.cn"));
if (!page) throw new Error("No yunchuang page found.");

const ws = new WebSocket(page.webSocketDebuggerUrl);
const matched = new Map();

wire(ws, async (msg) => {
  if (msg.method === "Network.requestWillBeSent") {
    const url = msg.params?.request?.url || "";
    if (url.includes("/attendance/human/rzAttendanceinfo/listByMonth")) {
      matched.set(msg.params.requestId, {
        url,
        headers: msg.params.request.headers
      });
      console.log("REQUEST");
      console.log(JSON.stringify(matched.get(msg.params.requestId), null, 2));
    }
  }

  if (msg.method === "Network.responseReceived" && matched.has(msg.params?.requestId)) {
    const item = matched.get(msg.params.requestId);
    item.response = {
      status: msg.params.response.status,
      mimeType: msg.params.response.mimeType,
      headers: msg.params.response.headers
    };
  }

  if (msg.method === "Network.loadingFinished" && matched.has(msg.params?.requestId)) {
    const item = matched.get(msg.params.requestId);
    try {
      const body = await send(ws, "Network.getResponseBody", { requestId: msg.params.requestId });
      item.bodyPreview = body.body.slice(0, 1200);
    } catch (error) {
      item.bodyError = error.message;
    }
    console.log("RESPONSE");
    console.log(JSON.stringify(item, null, 2));
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

await send(ws, "Network.enable");
await send(ws, "Runtime.enable");

const storage = await send(ws, "Runtime.evaluate", {
  expression: `(() => {
    const read = (name, s) => {
      const out = [];
      try {
        for (let i = 0; i < s.length; i++) {
          const key = s.key(i);
          const value = s.getItem(key);
          out.push({ name, key, valuePreview: String(value).slice(0, 120), length: String(value).length });
        }
      } catch (e) { out.push({ name, error: e.message }); }
      return out;
    };
    return [...read('localStorage', localStorage), ...read('sessionStorage', sessionStorage)];
  })()`,
  returnByValue: true
});

console.log("STORAGE");
console.log(JSON.stringify(storage.result.value, null, 2));

await send(ws, "Page.enable");
await send(ws, "Page.reload", { ignoreCache: true });

await new Promise((resolve) => setTimeout(resolve, 10000));
ws.close();
