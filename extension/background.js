/**
 * 云创考勤洞察 - Service Worker 入口
 * 职责：注册事件监听、协调各模块
 */
import { KEEPALIVE_ALARM, RETREAT_COUNTDOWN_ALARM, LOGIN_PATH } from "./modules/config.js";
import { saveAuthSnapshot, autoLogin, getApiOrigin } from "./modules/auth.js";
import { getAttendance, keepAlive, scheduleKeepAlive } from "./modules/attendance.js";
import {
  calculateRetreatTarget,
  checkAndRecalcRetreat,
  updateRetreatBadge,
  handleWindowRemoved,
  closeRetreatWindow,
  getRetreatStatus,
  scheduleRetreatAlarm
} from "./modules/retreat.js";

// ─── 生命周期 ────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  scheduleKeepAlive();
  scheduleRetreatAlarm();
  calculateRetreatTarget().then(() => updateRetreatBadge()).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  scheduleKeepAlive();
  scheduleRetreatAlarm();
  keepAlive();
  calculateRetreatTarget().then(() => updateRetreatBadge()).catch(() => {});
});

// ─── 定时器 ──────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    keepAlive().then(() => calculateRetreatTarget()).then(() => updateRetreatBadge()).catch(() => {});
  }
  if (alarm.name === RETREAT_COUNTDOWN_ALARM) {
    checkAndRecalcRetreat().then(() => updateRetreatBadge()).catch(() => {});
  }
});

// ─── 窗口关闭清理 ────────────────────────────────────────────

chrome.windows.onRemoved.addListener((windowId) => {
  handleWindowRemoved(windowId);
});

// ─── 消息路由 ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "YUNCHUANG_AUTH_SNAPSHOT") {
    saveAuthSnapshot(message.auth).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "GET_ATTENDANCE") {
    getAttendance(message.yearMonth, Boolean(message.force))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CLOSE_RETREAT_WINDOW") {
    closeRetreatWindow().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "OPEN_LOGIN") {
    getApiOrigin().then((origin) => chrome.tabs.create({ url: `${origin}${LOGIN_PATH}` }));
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "AUTO_LOGIN_NOW") {
    autoLogin()
      .then((auth) => sendResponse({
        ok: Boolean(auth),
        error: auth ? null : "自动登录未成功（验证码识别或账号密码问题），请查看后台日志。"
      }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CALCULATE_RETREAT") {
    calculateRetreatTarget().then(() => {
      updateRetreatBadge();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "GET_RETREAT_STATUS") {
    getRetreatStatus().then((data) => sendResponse({ ok: true, data }));
    return true;
  }

  return false;
});
