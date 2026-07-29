/**
 * 安全撤退模块：下班倒计时、badge 更新、呼吸灯预警
 */
import { CN_HOLIDAY_DATA } from "../holidays.js";
import { RETREAT_COUNTDOWN_ALARM, CACHE_PREFIX } from "./config.js";
import { toDateKey, log, warn, debug } from "./utils.js";

let retreatWindowId = null;

// ─── 工作日判断 ──────────────────────────────────────────────

/**
 * 判断指定日期是否为工作日
 * 优先级：法定假日 > 调休补班日 > 周一-五常规
 */
export function isWorkday(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const key = `${month}-${day}`;
  const yearData = CN_HOLIDAY_DATA[year];

  if (yearData) {
    if (yearData.h.includes(key)) return { isWorkday: false, type: "holiday" };
    if (yearData.w.includes(key)) return { isWorkday: true, type: "compensatory" };
  }

  const dayOfWeek = date.getDay();
  if (dayOfWeek >= 1 && dayOfWeek <= 5) return { isWorkday: true, type: "workday" };
  return { isWorkday: false, type: "weekend" };
}

// ─── 撤退目标计算 ────────────────────────────────────────────

export async function calculateRetreatTarget() {
  const today = new Date();
  const todayKey = toDateKey(today);

  const dayInfo = isWorkday(today);
  if (!dayInfo.isWorkday) {
    await chrome.storage.local.remove(["retreatTarget", "retreatAlertDate"]);
    return null;
  }

  const { retreatConfig } = await chrome.storage.local.get("retreatConfig");
  const config = retreatConfig || { enabled: true, defaultTime: "17:30", weekdayTimes: {} };

  if (!config.enabled) {
    await chrome.storage.local.remove(["retreatTarget", "retreatAlertDate"]);
    return null;
  }

  const dayOfWeek = today.getDay();
  const targetTime = (config.weekdayTimes && config.weekdayTimes[dayOfWeek]) || config.defaultTime || "17:30";

  // 超过下班时间 30 分钟宽限期后不再计算
  const [targetHH, targetMM] = targetTime.split(":").map(Number);
  const targetMinutes = targetHH * 60 + targetMM;
  const currentMinutes = today.getHours() * 60 + today.getMinutes();
  if (currentMinutes > targetMinutes + 30) {
    await chrome.storage.local.remove(["retreatTarget", "retreatAlertDate"]);
    return null;
  }

  const targetDate = new Date(`${todayKey}T${targetTime}:00`);
  const target = { date: todayKey, time: targetTime, timestamp: targetDate.getTime() };

  await chrome.storage.local.set({ retreatTarget: target });
  return target;
}

// ─── 打卡校验 ────────────────────────────────────────────────

/**
 * 判断员工是否已真正下班
 * 只有当 offworkTime >= 目标下班时间时才视为已下班
 */
async function hasActuallyLeftWork(targetTime) {
  const today = new Date();
  const todayKey = toDateKey(today);
  const monthKey = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}`;

  const [targetHH, targetMM] = targetTime.split(":").map(Number);
  const targetMinutes = targetHH * 60 + targetMM;
  const currentMinutes = today.getHours() * 60 + today.getMinutes();
  if (currentMinutes > targetMinutes + 30) return false;

  const cacheKey = `${CACHE_PREFIX}${monthKey}`;
  const cached = await chrome.storage.local.get(cacheKey);
  const records = cached[cacheKey]?.payload?.result?.records;
  if (!records) return false;

  const todayRecord = records.find(r => r.attendanceDate === todayKey);
  if (!todayRecord) return false;

  const offworkTime = todayRecord.offworkTime;
  if (!offworkTime || offworkTime.includes("00:00:00")) return false;

  const offworkMatch = offworkTime.match(/(\d{2}):(\d{2})/);
  if (!offworkMatch) return false;
  const offworkMinutes = parseInt(offworkMatch[1], 10) * 60 + parseInt(offworkMatch[2], 10);

  return offworkMinutes >= targetMinutes;
}

// ─── 跨天检测 ────────────────────────────────────────────────

export async function checkAndRecalcRetreat() {
  const { retreatTarget } = await chrome.storage.local.get("retreatTarget");
  const todayKey = toDateKey();
  if (!retreatTarget || retreatTarget.date !== todayKey) {
    await calculateRetreatTarget();
  }
}

// ─── Badge 更新 ──────────────────────────────────────────────

/**
 * 更新浏览器 action badge 显示倒计时
 * 显示规则：
 *   剩余 > 5min: "2h15m" / "45m" 蓝色
 *   剩余 1-5min: 分钟数 绿色
 *   剩余 < 1min: 秒数 红色
 *   剩余 <= 0 且未触发过: "GO!" 绿色，触发呼吸灯+通知
 *   剩余 < -30min: 清除 badge
 */
export async function updateRetreatBadge() {
  const { retreatConfig } = await chrome.storage.local.get("retreatConfig");
  const config = retreatConfig || { enabled: true, defaultTime: "17:30", weekdayTimes: {} };

  if (!config.enabled) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }

  const { retreatTarget } = await chrome.storage.local.get("retreatTarget");
  if (!retreatTarget) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }

  const todayKey = toDateKey();
  if (retreatTarget.date !== todayKey) {
    calculateRetreatTarget().catch(() => {});
    chrome.action.setBadgeText({ text: "" });
    return;
  }

  const leftWork = await hasActuallyLeftWork(retreatTarget.time);
  if (leftWork) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }

  const remainingMs = retreatTarget.timestamp - Date.now();
  const remainingSec = Math.max(0, Math.round(remainingMs / 1000));
  const remainingMin = Math.round(remainingMs / 60000);

  // 根据剩余时间动态调整 alarm 频率
  adjustAlarmFrequency(remainingSec);

  if (remainingSec < 300 && remainingSec > 0) {
    if (remainingSec < 60) {
      chrome.action.setBadgeText({ text: `${remainingSec}s` });
      chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    } else {
      const min = Math.ceil(remainingSec / 60);
      chrome.action.setBadgeText({ text: `${min}m` });
      chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
    }
  } else if (remainingMin > 60) {
    const hours = Math.floor(remainingMin / 60);
    const mins = remainingMin % 60;
    chrome.action.setBadgeText({ text: mins > 0 ? `${hours}h${mins}m` : `${hours}h` });
    chrome.action.setBadgeBackgroundColor({ color: "#6366f1" });
  } else if (remainingMin >= 1) {
    chrome.action.setBadgeText({ text: `${remainingMin}m` });
    chrome.action.setBadgeBackgroundColor({ color: "#6366f1" });
  } else if (remainingMin > -30) {
    const { retreatAlertDate } = await chrome.storage.local.get("retreatAlertDate");
    if (retreatAlertDate !== todayKey) {
      chrome.action.setBadgeText({ text: "GO!" });
      chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
      await triggerRetreatAlert();
    } else {
      chrome.action.setBadgeText({ text: "GO!" });
      chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
    }
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

// ─── 呼吸灯预警 ──────────────────────────────────────────────

async function triggerRetreatAlert() {
  const todayKey = toDateKey();
  await chrome.storage.local.set({ retreatAlertDate: todayKey });

  // 1. 系统通知
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon128.png"),
      title: "到点啦，准备撤退！",
      message: "已达下班时间，记得打卡哦~"
    });
  } catch (e) {
    warn("通知发送失败：", e.message);
  }

  // 2. 全屏呼吸灯窗口
  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL("retreat-alert.html"),
      type: "popup",
      state: "maximized",
      focused: true
    });
    retreatWindowId = win?.id;
    await chrome.storage.local.set({ retreatWindowId: win?.id });
    log(`呼吸灯窗口已打开，windowId=${win?.id}`);
  } catch (e) {
    warn("呼吸灯窗口打开失败：", e.message);
    try {
      const win2 = await chrome.windows.create({
        url: chrome.runtime.getURL("retreat-alert.html"),
        type: "popup",
        focused: true
      });
      retreatWindowId = win2?.id;
      await chrome.storage.local.set({ retreatWindowId: win2?.id });
      log("呼吸灯窗口已打开（降级模式）");
    } catch (e2) {
      warn("呼吸灯窗口降级也失败：", e2.message);
    }
  }
}

// ─── 窗口关闭处理 ────────────────────────────────────────────

export function handleWindowRemoved(windowId) {
  if (windowId === retreatWindowId) {
    retreatWindowId = null;
    chrome.storage.local.remove("retreatWindowId").catch(() => {});
  }
}

export async function closeRetreatWindow() {
  let windowId = retreatWindowId;
  if (windowId == null) {
    const stored = await chrome.storage.local.get("retreatWindowId");
    windowId = stored.retreatWindowId;
  }
  if (windowId != null) {
    try {
      await chrome.windows.remove(windowId);
    } catch (e) {
      warn("关闭窗口失败：", e.message);
    }
  }
  retreatWindowId = null;
  await chrome.storage.local.remove("retreatWindowId");
}

// ─── 状态查询（供设置页面） ──────────────────────────────────

export async function getRetreatStatus() {
  const { retreatConfig, retreatTarget } = await chrome.storage.local.get([
    "retreatConfig", "retreatTarget"
  ]);

  const config = retreatConfig || { enabled: true, defaultTime: "17:30", weekdayTimes: {} };
  const todayKey = toDateKey();

  let remaining = null;
  if (retreatTarget && retreatTarget.date === todayKey) {
    const diffMs = retreatTarget.timestamp - Date.now();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin > 0) {
      remaining = {
        minutes: diffMin,
        hours: Math.floor(diffMin / 60),
        mins: diffMin % 60,
        targetTime: retreatTarget.time
      };
    } else {
      remaining = { minutes: diffMin, targetTime: retreatTarget.time };
    }
  }

  const { retreatAlertDate } = await chrome.storage.local.get("retreatAlertDate");
  const alreadyTriggered = retreatAlertDate === todayKey;

  return { config, remaining, todayKey, alreadyTriggered };
}

// ─── Alarm 智能调度 ─────────────────────────────────────────
// 剩余 > 5min：每 5 分钟唤醒一次（badge 只显示分钟级）
// 剩余 ≤ 5min：每 30 秒唤醒一次（秒级倒计时）
// 到点后 / 非工作日：清除 alarm 不再唤醒

const ALARM_SLOW_MINUTES = 5;   // 粗粒度间隔
const ALARM_FAST_MINUTES = 0.5; // 细粒度间隔（30s，Chrome 最小值）
let currentAlarmFast = false;

export function scheduleRetreatAlarm() {
  // 初始用慢间隔，updateRetreatBadge 会根据剩余时间动态切换
  chrome.alarms.create(RETREAT_COUNTDOWN_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: ALARM_SLOW_MINUTES
  });
  currentAlarmFast = false;
}

function adjustAlarmFrequency(remainingSec) {
  const needFast = remainingSec > 0 && remainingSec <= 300;
  if (needFast && !currentAlarmFast) {
    chrome.alarms.create(RETREAT_COUNTDOWN_ALARM, {
      delayInMinutes: 0,
      periodInMinutes: ALARM_FAST_MINUTES
    });
    currentAlarmFast = true;
  } else if (!needFast && currentAlarmFast) {
    chrome.alarms.create(RETREAT_COUNTDOWN_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: ALARM_SLOW_MINUTES
    });
    currentAlarmFast = false;
  }
}
