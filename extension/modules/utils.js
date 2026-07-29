/**
 * 公共工具函数
 */
import { DEBUG } from "./config.js";

/** 日期 → "YYYY-MM-DD" */
export function toDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 日期 → "YYYYMM" */
export function toYearMonth(date = new Date()) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** 当前月份 "YYYYMM" */
export function currentYearMonth() {
  return toYearMonth(new Date());
}

/**
 * 获取目标域名的所有 cookies，构造 Cookie 请求头字符串。
 * service worker 的 fetch 不一定能自动带上目标域的 cookies，
 * 所以通过 chrome.cookies API 显式获取并拼接到请求头中。
 */
export async function getCookieHeader(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (cookies.length === 0) return "";
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

/** 带 [考勤插件] 前缀的日志 */
export function log(...args) {
  console.log("[考勤插件]", ...args);
}

export function warn(...args) {
  console.warn("[考勤插件]", ...args);
}

/** 仅 DEBUG=true 时输出 */
export function debug(...args) {
  if (DEBUG) console.log("[考勤插件][debug]", ...args);
}
