import { CN_HOLIDAY_DATA } from "./holidays.js";

const NORMAL_DAILY_HOURS = 8;
const API_FALLBACK_ERROR = "获取失败。请保持云创页面打开并已登录，然后点击刷新。";

const els = {
  refreshBtn: document.querySelector("#refreshBtn"),
  prevMonth: document.querySelector("#prevMonth"),
  nextMonth: document.querySelector("#nextMonth"),
  statusPanel: document.querySelector("#statusPanel"),
  statusTitle: document.querySelector("#statusTitle"),
  statusText: document.querySelector("#statusText"),
  loginBtn: document.querySelector("#loginBtn"),
  monthLabel: document.querySelector("#monthLabel"),
  avgHours: document.querySelector("#avgHours"),
  actualHours: document.querySelector("#actualHours"),
  abnormalHours: document.querySelector("#abnormalHours"),
  abnormalCount: document.querySelector("#abnormalCount"),
  overtimeDays: document.querySelector("#overtimeDays"),
  requiredHours: document.querySelector("#requiredHours"),
  leaveHours: document.querySelector("#leaveHours"),
  calendarGrid: document.querySelector("#calendarGrid"),
  cacheInfo: document.querySelector("#cacheInfo"),
  settingsBtn: document.querySelector("#settingsBtn")
};

const isExtension = location.protocol === "chrome-extension:"
  && typeof chrome !== "undefined"
  && chrome.runtime?.id
  && chrome.runtime?.sendMessage;

let state = {
  yearMonth: toYearMonth(new Date()),
  records: [],
  fetchedAt: null,
  fromCache: false,
  stale: false
};

init();

async function init() {
  // 初始化主题
  const { themePreference } = await chrome.storage.local.get("themePreference");
  if (themePreference === "dark") {
    document.documentElement.dataset.theme = "dark";
  } else if (themePreference === "contrast") {
    document.documentElement.dataset.theme = "contrast";
    document.documentElement.style.colorScheme = "dark";
  } else if (themePreference === "light") {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "light";
  } else {
    // "system" 或 undefined -> 跟随系统
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.removeProperty("color-scheme");
  }

  els.refreshBtn.addEventListener("click", () => loadAttendance(true));
  els.prevMonth.addEventListener("click", () => shiftMonth(-1));
  els.nextMonth.addEventListener("click", () => shiftMonth(1));
  els.loginBtn.addEventListener("click", () => {
    if (isExtension) chrome.runtime.sendMessage({ type: "OPEN_LOGIN" });
  });
  els.settingsBtn.addEventListener("click", () => {
    if (isExtension) {
      chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
    }
  });
  initialLoad();
}

// 打开 popup 先秒出缓存，随后自动刷新拿最新数据；
// 刷新失败会显示明确提示，不再静默无反应。
async function initialLoad() {
  await loadAttendance(false);
  if (state.fromCache) {
    await loadAttendance(true);
  }
}

async function loadAttendance(force) {
  setLoading(true);
  hideStatus();
  try {
    const data = await fetchAttendance(state.yearMonth, force);
    state.records = data.payload?.result?.records ?? [];
    state.fetchedAt = data.fetchedAt;
    state.fromCache = data.fromCache;
    state.stale = false;
    render();
    hideStatus();
  } catch (error) {
    const cached = await getCachedAttendance(state.yearMonth);
    state.stale = true;
    if (cached?.payload?.result?.records?.length > 0) {
      state.records = cached.payload.result.records;
      state.fetchedAt = cached.fetchedAt;
      state.fromCache = true;
      render();
      showStatus("刷新失败，展示缓存数据", error.message || API_FALLBACK_ERROR);
    } else {
      state.records = [];
      render();
      showStatus("需要登录或刷新", error.message || API_FALLBACK_ERROR);
    }
  } finally {
    setLoading(false);
  }
}

async function getCachedAttendance(yearMonth) {
  if (!isExtension) return null;
  const cacheKey = `attendance:${yearMonth}`;
  const cached = await chrome.storage.local.get(cacheKey);
  return cached[cacheKey] || null;
}

async function fetchAttendance(yearMonth, force) {
  if (!isExtension) {
    return demoAttendance(yearMonth);
  }

  const response = await chrome.runtime.sendMessage({
    type: "GET_ATTENDANCE",
    yearMonth,
    force
  });

  if (!response?.ok) {
    throw new Error(response?.error || API_FALLBACK_ERROR);
  }
  return response.data;
}

function render() {
  const year = state.yearMonth.slice(0, 4);
  const month = state.yearMonth.slice(4, 6);
  els.monthLabel.textContent = `${year}年${parseInt(month)}月`;

  const stats = calculateStats(state.records, state.yearMonth);
  els.avgHours.textContent = stats.averageHours == null ? "--" : `${stats.averageHours.toFixed(2)}h`;
  els.actualHours.textContent = `${stats.actualHours.toFixed(2)}h`;
  els.abnormalHours.textContent = `${stats.abnormalHours.toFixed(2)}h`;
  els.abnormalCount.textContent = `${stats.abnormalRecords.length}`;
  els.overtimeDays.textContent = `${stats.restOvertimeRecords.length}`;
  els.requiredHours.textContent = `应出勤 ${stats.requiredHours.toFixed(2)}h`;
  els.leaveHours.textContent = `请假 ${stats.leaveHours.toFixed(2)}h`;
  els.cacheInfo.textContent = state.fetchedAt ? `${state.fromCache ? "缓存" : "已刷新"} ${formatFetchedAt(state.fetchedAt)}` : "--";
  els.cacheInfo.classList.toggle("stale", state.stale);

  renderCalendar(state.records, state.yearMonth);
}

function calculateStats(records, yearMonth) {
  const todayKey = dateKey(new Date());
  const currentMonth = toYearMonth(new Date());
  const rows = records.map(normalizeRecord);
  const included = rows.filter((row) => {
    const effectiveRequiredHours = Math.max(row.workLength - row.leaveHours, 0);
    if (!row.isWorkday) return false;
    if (effectiveRequiredHours <= 0) return false;
    if (yearMonth === currentMonth && row.date >= todayKey) return false;
    return true;
  });

  const totals = included.reduce((acc, row) => {
    const effectiveRequiredHours = Math.max(row.workLength - row.leaveHours, 0);
    acc.actualHours += row.duration;
    acc.requiredHours += effectiveRequiredHours;
    acc.leaveHours += row.leaveHours;
    acc.abnormalHours += row.missHours;
    acc.overtimeHours += row.overtimeHours;
    return acc;
  }, { actualHours: 0, requiredHours: 0, leaveHours: 0, abnormalHours: 0, overtimeHours: 0 });

  const effectiveDays = totals.requiredHours / NORMAL_DAILY_HOURS;
  const averageHours = effectiveDays > 0 ? totals.actualHours / effectiveDays : null;
  const abnormalRecords = rows.filter(isAbnormal);
  const restOvertimeRecords = rows.filter(isRestOvertime);

  return {
    ...totals,
    effectiveDays,
    averageHours,
    abnormalRecords,
    restOvertimeRecords
  };
}

function renderCalendar(records, yearMonth) {
  const recordMap = new Map(records.map((record) => [record.attendanceDate, normalizeRecord(record)]));
  const year = Number(yearMonth.slice(0, 4));
  const month = Number(yearMonth.slice(4, 6)) - 1;
  const firstDate = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leading = (firstDate.getDay() + 6) % 7;
  const today = dateKey(new Date());
  const fragments = [];

  for (let i = 0; i < leading; i += 1) {
    fragments.push('<div class="cal-day empty"></div>');
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = `${yearMonth.slice(0, 4)}-${yearMonth.slice(4)}-${String(day).padStart(2, "0")}`;
    const row = recordMap.get(key);
    const dateObj = new Date(year, month, day);
    const isWeekend = dateObj.getDay() === 0 || dateObj.getDay() === 6;
    const classes = ["cal-day"];

    if (key === today) classes.push("today");
    if (isWeekend) classes.push("weekend");

    // 法定假日 / 调休补班角标
    const mmdd = `${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const yearData = CN_HOLIDAY_DATA[year];
    let dayBadge = "";
    if (yearData) {
      if (yearData.h.includes(mmdd)) {
        dayBadge = "休";
        classes.push("holiday");
      } else if (yearData.w.includes(mmdd)) {
        dayBadge = "班";
        classes.push("compensatory");
      }
    }

    if (!row) {
      // no record
    } else if (isAbnormal(row)) {
      classes.push("abnormal");
    } else if (isRestOvertime(row)) {
      classes.push("overtime");
    } else if (row.leaveHours > 0) {
      classes.push("leave");
    } else if (row.isWorkday && row.duration > 0) {
      classes.push("normal");
    }

    const isOvertime = row && isRestOvertime(row);
    const hoursText = row && row.duration > 0 ? row.duration.toFixed(1) + "h" : "";
    const timeText = row && row.startTime ? `${row.startTime} 至 ${row.endTime || "--"}` : "";
    const statusText = row ? getStatusText(row) : "";

    fragments.push(`
      <div class="${classes.join(" ")}" title="${escapeHtml(tileTitle(row, key))}">
        ${dayBadge ? `<span class="day-badge ${dayBadge === "休" ? "badge-holiday" : "badge-compensatory"}">${dayBadge}</span>` : ""}
        <div class="day-header">
          <span class="day-num">${day}</span>
          ${statusText ? `<span class="day-status">${statusText}</span>` : ""}
        </div>
        ${hoursText ? `<div class="day-hours">${hoursText}</div>` : ""}
        ${timeText ? `<div class="day-time">${timeText}</div>` : ""}
      </div>
    `);
  }

  els.calendarGrid.innerHTML = fragments.join("");
}

function normalizeRecord(record) {
  return {
    raw: record,
    date: record.attendanceDate,
    isWorkday: record.dayType_dictText === "工作日",
    dayType: record.dayType_dictText || "",
    status: record.status_dictText || "",
    exception: record.exception_dictText || "",
    duration: numberValue(record.duration),
    workLength: numberValue(record.workLength),
    leaveHours: numberValue(record.leaveDuration),
    missHours: numberValue(record.missDuration),
    overtimeHours: numberValue(record.overtimeDuration),
    lateMinutes: numberValue(record.lateTime),
    leaveEarlyMinutes: numberValue(record.leaveEarlyTime),
    workTimeNormal: record.workTimeNormal !== false,
    offWorkTimeNormal: record.offWorkTimeNormal !== false,
    startTime: displayTime(record.workingTime),
    endTime: displayTime(record.offworkTime),
    statusIn: record.statusStr || "",
    statusOut: record.offStatusStr || ""
  };
}

function isAbnormal(row) {
  return row.status === "异常"
    || Boolean(row.exception)
    || row.missHours > 0
    || row.workTimeNormal === false
    || row.offWorkTimeNormal === false;
}

function isRestOvertime(row) {
  return Boolean(row)
    && !row.isWorkday
    && Boolean(row.startTime)
    && Boolean(row.endTime);
}

function getStatusText(row) {
  if (row.status === "异常") return "异常";
  if (row.exception) return "异常";
  if (row.missHours > 0) return "异常";
  if (!row.isWorkday && row.startTime) return "加班";
  if (row.leaveHours > 0) return "请假";
  return "正常";
}

function tileTitle(row, key) {
  if (!row) return `${key} 无记录`;
  return [
    row.date,
    row.dayType,
    row.status || "无状态",
    row.exception ? `异常：${row.exception}` : "",
    `上班：${row.statusIn || row.startTime || "--"}`,
    `下班：${row.statusOut || row.endTime || "--"}`,
    `工时：${row.duration.toFixed(2)}h`,
    row.leaveHours ? `请假：${row.leaveHours.toFixed(2)}h` : "",
    row.missHours ? `异常：${row.missHours.toFixed(2)}h` : ""
  ].filter(Boolean).join("\n");
}

function shiftMonth(delta) {
  const year = Number(state.yearMonth.slice(0, 4));
  const month = Number(state.yearMonth.slice(4, 6)) - 1;
  const date = new Date(year, month + delta, 1);
  state.yearMonth = toYearMonth(date);
  loadAttendance(false);
}

function showStatus(title, text) {
  els.statusTitle.textContent = title;
  els.statusText.textContent = text;
  els.statusPanel.hidden = false;
}

function hideStatus() {
  els.statusPanel.hidden = true;
}

function setLoading(loading) {
  document.body.classList.toggle("loading", loading);
  els.refreshBtn.disabled = loading;
}

function toYearMonth(date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function displayTime(value) {
  if (!value || value.includes("00:00:00")) return "";
  const match = value.match(/(\d{2}:\d{2})/);
  return match ? match[1] : "";
}

function numberValue(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function formatFetchedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function demoAttendance(yearMonth) {
  const records = [
    ["01", "工作日", "正常", "", "08:01", "18:33", 8.53, 8, 0, 0],
    ["02", "工作日", "正常", "", "07:59", "17:45", 8.02, 8, 0, 0],
    ["03", "工作日", "正常", "", "08:16", "19:00", 8.73, 8, 0, 0],
    ["04", "休息日", "正常", "", "07:47", "17:35", 0, 8, 0, 0],
    ["05", "休息日", "正常", "", "--", "--", 0, 8, 0, 0],
    ["06", "工作日", "正常", "", "07:50", "20:38", 10.8, 8, 0, 0],
    ["07", "工作日", "正常", "", "08:12", "17:57", 7.8, 8, 0, 0],
    ["08", "工作日", "正常", "", "07:58", "18:00", 8.03, 8, 0, 0],
    ["09", "工作日", "异常", "旷工", "12:08", "20:36", 6.6, 8, 4, 4],
    ["10", "工作日", "正常", "", "08:12", "17:54", 7.8, 8, 0, 0],
    ["13", "工作日", "正常", "", "08:21", "20:38", 10.28, 8, 0, 0],
    ["14", "工作日", "正常", "", "08:10", "19:40", 9.5, 8, 0, 0],
    ["15", "工作日", "正常", "", "08:11", "17:44", 7.82, 8, 0, 0],
    ["16", "工作日", "正常", "", "08:17", "17:38", 7.72, 8, 0, 0],
    ["17", "工作日", "正常", "", "08:16", "17:40", 7.73, 8, 0, 0]
  ].map(([day, dayType, status, exception, start, end, duration, workLength, leaveDuration, missDuration]) => {
    const hasStart = start !== "--";
    const hasEnd = end !== "--";
    return {
      attendanceDate: `${yearMonth.slice(0, 4)}-${yearMonth.slice(4)}-${day}`,
      dayType_dictText: dayType,
      status_dictText: status,
      exception_dictText: exception || undefined,
      workingTime: hasStart ? `${yearMonth.slice(0, 4)}-${yearMonth.slice(4)}-${day} ${start}:00` : `${yearMonth.slice(0, 4)}-${yearMonth.slice(4)}-${day} 00:00:00`,
      offworkTime: hasEnd ? `${yearMonth.slice(0, 4)}-${yearMonth.slice(4)}-${day} ${end}:00` : `${yearMonth.slice(0, 4)}-${yearMonth.slice(4)}-${day} 00:00:00`,
      duration,
      workLength,
      leaveDuration,
      missDuration,
      overtimeDuration: 0,
      workTimeNormal: !exception,
      offWorkTimeNormal: true,
      statusStr: hasStart ? (exception ? `迟到打卡(${start})` : `正常打卡(${start})`) : "",
      offStatusStr: hasEnd ? `正常打卡(${end})` : ""
    };
  });

  return {
    yearMonth,
    fetchedAt: new Date().toISOString(),
    fromCache: false,
    payload: {
      success: true,
      code: 200,
      result: { records }
    }
  };
}
