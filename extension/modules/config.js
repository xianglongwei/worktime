/**
 * 全局常量配置
 */
export const API_ORIGINS = [
  "https://yunchuang.talkweb.com.cn",
  "https://yunchuanghq.talkweb.com.cn"
];

export const ATTENDANCE_PATH = "/attendance/human/rzAttendanceinfo/listByMonth";
export const LOGIN_PATH = "/dashboard/analysis";
export const CAPTCHA_PATH = "/auth/sys/randomImage";
export const LOGIN_API_PATH = "/auth/sys/login";
export const CACHE_PREFIX = "attendance:";
export const KEEPALIVE_ALARM = "yunchuang-keepalive";
export const KEEPALIVE_PERIOD_MINUTES = 30;
export const RETREAT_COUNTDOWN_ALARM = "retreat-countdown";
export const MAX_LOGIN_ATTEMPTS = 8;

/** 调试开关：设为 true 输出详细日志 */
export const DEBUG = false;
