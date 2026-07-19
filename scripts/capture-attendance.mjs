import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CDP_LIST_URL = "http://127.0.0.1:9222/json/list";
const TARGET_PATH = "/attendance/human/rzAttendanceinfo/listByMonth";
const yearMonth = process.argv[2] || new Date().toISOString().slice(0, 7).replace("-", "");
const outDir = join(process.cwd(), "data");

function send(ws, method, params = {}) {
  const id = ++send.lastId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      send.pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 15000);
    send.pending.set(id, { resolve, reject, timeout });
  });
}
send.lastId = 0;
send.pending = new Map();

async function main() {
  const tabs = await fetch(CDP_LIST_URL).then((res) => res.json());
  const page = tabs.find((tab) => tab.type === "page" && tab.url.includes("yunchuang.talkweb.com.cn"));
  if (!page) {
    throw new Error("No yunchuang.talkweb.com.cn page found on CDP port 9222.");
  }

  console.log(`Using page: ${page.title} ${page.url}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const requestIds = new Map();

  ws.addEventListener("message", async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && send.pending.has(msg.id)) {
      const pending = send.pending.get(msg.id);
      send.pending.delete(msg.id);
      clearTimeout(pending.timeout);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
      return;
    }

    if (msg.method === "Network.requestWillBeSent") {
      const url = msg.params?.request?.url || "";
      if (url.includes(TARGET_PATH) && url.includes(`yearMonth=${yearMonth}`)) {
        requestIds.set(msg.params.requestId, url);
        console.log(`Matched request: ${url}`);
      }
    }

    if (msg.method === "Network.loadingFinished" && requestIds.has(msg.params?.requestId)) {
      const url = requestIds.get(msg.params.requestId);
      try {
        const body = await send(ws, "Network.getResponseBody", { requestId: msg.params.requestId });
        await mkdir(outDir, { recursive: true });
        const rawPath = join(outDir, `attendance-${yearMonth}.raw.txt`);
        const jsonPath = join(outDir, `attendance-${yearMonth}.json`);
        await writeFile(rawPath, body.body, "utf8");
        try {
          await writeFile(jsonPath, JSON.stringify(JSON.parse(body.body), null, 2), "utf8");
          console.log(`Saved JSON: ${jsonPath}`);
        } catch {
          console.log(`Saved raw response: ${rawPath}`);
        }
        console.log(`Captured from: ${url}`);
        ws.close();
      } catch (error) {
        console.error(`Failed to read response body: ${error.message}`);
        ws.close();
      }
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  await send(ws, "Network.enable");
  await send(ws, "Page.enable");
  await send(ws, "Page.reload", { ignoreCache: true });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${TARGET_PATH}?yearMonth=${yearMonth}`)), 30000);
    ws.addEventListener("close", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
