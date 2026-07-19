let id = 0;
const pending = new Map();

function send(ws, method, params = {}) {
  const messageId = ++id;
  ws.send(JSON.stringify({ id: messageId, method, params }));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(messageId);
      reject(new Error(`${method} timeout`));
    }, 15000);
    pending.set(messageId, { resolve, reject, timeout });
  });
}

const tabs = await fetch("http://127.0.0.1:9222/json/list").then((res) => res.json());
const page = tabs.find((tab) => tab.type === "page" && tab.url.includes("yunchuang.talkweb.com.cn"));
if (!page) throw new Error("9222 上没找到云创页面");

const ws = new WebSocket(page.webSocketDebuggerUrl);
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

  if (msg.method === "Network.requestWillBeSent" && msg.params.request.url.includes("/attendance/human/rzAttendanceinfo/listByMonth")) {
    console.log(JSON.stringify({
      url: msg.params.request.url,
      headers: msg.params.request.headers
    }, null, 2));
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

await send(ws, "Network.enable");
await send(ws, "Page.reload", { ignoreCache: true });
setTimeout(() => ws.close(), 8000);
await new Promise((resolve) => ws.addEventListener("close", resolve, { once: true }));
