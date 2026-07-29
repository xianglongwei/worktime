// 加载自定义提示词
(async () => {
  try {
    const { retreatConfig } = await chrome.storage.local.get("retreatConfig");
    const customText = retreatConfig?.alertText;
    if (customText && customText.trim()) {
      document.getElementById("alertText").textContent = customText.trim();
    }
  } catch (e) { /* 非扩展环境，使用默认文字 */ }
})();

// 关闭逻辑：优先本页面直接关闭窗口，不依赖 background SW
let closing = false;
async function closeAlert() {
  if (closing) return;
  closing = true;

  // 方式1：本页面直接获取当前窗口并关闭（最可靠，无需 SW 参与）
  try {
    const win = await chrome.windows.getCurrent();
    if (win?.id) {
      await chrome.windows.remove(win.id);
      return;
    }
  } catch (e) { /* 继续降级 */ }

  // 方式2：通过 background 脚本关闭（兼容旧逻辑）
  try {
    const resp = await chrome.runtime.sendMessage({ type: "CLOSE_RETREAT_WINDOW" });
    if (resp?.ok) return;
  } catch (e) { /* 继续降级 */ }

  // 方式3：获取自身 tab 并关闭
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) { await chrome.tabs.remove(tab.id); return; }
  } catch (e) { /* 继续降级 */ }

  // 方式4：最终降级
  try { window.close(); } catch (e) { /* 无法关闭 */ }
}

document.getElementById("closeBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  closeAlert();
});
document.addEventListener("click", closeAlert);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAlert(); });
setTimeout(closeAlert, 15000);
