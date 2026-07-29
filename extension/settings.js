// Settings page - manages login credentials, retreat config, theme, and navigation

const isExtension = location.protocol === "chrome-extension:"
  && typeof chrome !== "undefined"
  && chrome.runtime?.id
  && chrome.runtime?.sendMessage;

const els = {
  usernameInput: document.querySelector("#usernameInput"),
  passwordInput: document.querySelector("#passwordInput"),
  autoLoginToggle: document.querySelector("#autoLoginToggle"),
  saveCreds: document.querySelector("#saveCreds"),
  testLogin: document.querySelector("#testLogin"),
  loginHint: document.querySelector("#loginHint"),
  retreatEnabled: document.querySelector("#retreatEnabled"),
  defaultRetreatTime: document.querySelector("#defaultRetreatTime"),
  alertTextInput: document.querySelector("#alertTextInput"),
  retreatStatusText: document.querySelector("#retreatStatusText"),
  weekdayTimes: document.querySelectorAll(".weekday-time"),
  resetRetreatDefaults: document.querySelector("#resetRetreatDefaults"),
  themeRadios: document.querySelectorAll('input[name="theme"]'),
  navItems: document.querySelectorAll(".nav-item"),
  panels: document.querySelectorAll(".panel")
};

init();

async function init() {
  // Navigation
  initNavigation();
  // Theme initialization
  await applyTheme();
  // Load login credentials
  await loadCreds();
  // Load retreat config
  await loadRetreatConfig();
  // Load and display retreat status
  await refreshRetreatStatus();

  // Event listeners
  els.saveCreds.addEventListener("click", saveCredsHandler);
  els.testLogin.addEventListener("click", testLoginHandler);

  // Retreat config auto-save on change
  els.retreatEnabled.addEventListener("change", saveRetreatConfig);
  els.defaultRetreatTime.addEventListener("change", saveRetreatConfig);
  els.alertTextInput.addEventListener("change", saveRetreatConfig);
  els.weekdayTimes.forEach(input => {
    input.addEventListener("change", saveRetreatConfig);
  });

  // Theme change
  els.themeRadios.forEach(radio => {
    radio.addEventListener("change", () => {
      const selected = document.querySelector('input[name="theme"]:checked');
      if (selected) applyThemePreference(selected.value);
    });
  });

  // Reset retreat defaults
  els.resetRetreatDefaults.addEventListener("click", resetRetreatDefaults);

  // Refresh retreat status every minute
  setInterval(refreshRetreatStatus, 60000);
}

// ===== Navigation =====

function initNavigation() {
  els.navItems.forEach(item => {
    item.addEventListener("click", () => {
      const target = item.dataset.panel;
      // 切换导航高亮
      els.navItems.forEach(n => n.classList.remove("active"));
      item.classList.add("active");
      // 切换面板
      els.panels.forEach(p => p.classList.remove("active"));
      const panel = document.getElementById(`panel-${target}`);
      if (panel) panel.classList.add("active");
    });
  });
}

// ===== Theme =====

async function applyTheme() {
  const { themePreference } = await chrome.storage.local.get("themePreference");
  if (themePreference === "dark") {
    document.documentElement.dataset.theme = "dark";
  } else if (themePreference === "light") {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "light";
  } else {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.removeProperty("color-scheme");
  }
  // Sync radio
  const value = themePreference || "system";
  const radio = document.querySelector(`input[name="theme"][value="${value}"]`);
  if (radio) radio.checked = true;
}

async function applyThemePreference(preference) {
  await chrome.storage.local.set({ themePreference: preference });
  if (preference === "dark") {
    document.documentElement.dataset.theme = "dark";
  } else if (preference === "light") {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "light";
  } else {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.removeProperty("color-scheme");
  }
}

// ===== Login Credentials =====

async function loadCreds() {
  if (!isExtension) return;
  const stored = await chrome.storage.local.get("loginCreds");
  const creds = stored.loginCreds || {};
  els.usernameInput.value = creds.username || "";
  els.passwordInput.value = creds.password || "";
  els.autoLoginToggle.checked = Boolean(creds.autoLogin);
}

async function saveCredsHandler() {
  if (!isExtension) return;
  const username = els.usernameInput.value.trim();
  const password = els.passwordInput.value;
  const autoLogin = els.autoLoginToggle.checked;
  if (autoLogin && (!username || !password)) {
    setLoginHint("Please fill in both username and password to enable auto-login.", true);
    return;
  }
  await chrome.storage.local.set({ loginCreds: { username, password, autoLogin } });
  setLoginHint("Saved.", false);
}

async function testLoginHandler() {
  if (!isExtension) return;
  await saveCredsHandler();
  if (!els.autoLoginToggle.checked) {
    setLoginHint("Please enable auto-login first.", true);
    return;
  }
  setLoginHint("Testing login... CAPTCHA recognition may take a few seconds.", false);
  els.testLogin.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "AUTO_LOGIN_NOW" });
    if (response?.ok) {
      setLoginHint("Login successful, auto-renewal is active.", false);
    } else {
      setLoginHint(response?.error || "Login failed. Please check credentials.", true);
    }
  } catch (error) {
    setLoginHint(error.message || "Login failed.", true);
  } finally {
    els.testLogin.disabled = false;
  }
}

function setLoginHint(text, isError) {
  els.loginHint.textContent = text;
  els.loginHint.classList.toggle("error", Boolean(isError));
}

// ===== Retreat Config =====

async function loadRetreatConfig() {
  const { retreatConfig } = await chrome.storage.local.get("retreatConfig");
  const config = retreatConfig || { enabled: true, defaultTime: "17:30", weekdayTimes: {} };
  els.retreatEnabled.checked = config.enabled !== false;
  els.defaultRetreatTime.value = config.defaultTime || "17:30";
  els.alertTextInput.value = config.alertText || "";
  // Populate weekday times
  els.weekdayTimes.forEach(input => {
    const day = input.dataset.day;
    input.value = (config.weekdayTimes && config.weekdayTimes[day]) || "";
  });
}

async function saveRetreatConfig() {
  const enabled = els.retreatEnabled.checked;
  const defaultTime = els.defaultRetreatTime.value || "17:30";
  const alertText = els.alertTextInput.value.trim();
  const weekdayTimes = {};
  els.weekdayTimes.forEach(input => {
    if (input.value) {
      weekdayTimes[input.dataset.day] = input.value;
    }
  });
  const config = { enabled, defaultTime, alertText, weekdayTimes };
  await chrome.storage.local.set({ retreatConfig: config });
  // Trigger recalculation
  if (isExtension) {
    chrome.runtime.sendMessage({ type: "CALCULATE_RETREAT" });
  }
  // Refresh status after a short delay
  setTimeout(refreshRetreatStatus, 500);
}

async function resetRetreatDefaults() {
  // 清空所有自定义星期时间，恢复默认 17:30
  els.defaultRetreatTime.value = "17:30";
  els.alertTextInput.value = "";
  els.weekdayTimes.forEach(input => { input.value = ""; });
  await saveRetreatConfig();
  // 视觉反馈
  const btn = els.resetRetreatDefaults;
  const original = btn.textContent;
  btn.textContent = "✓ 已恢复默认";
  btn.disabled = true;
  setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1500);
}

async function refreshRetreatStatus() {
  if (!isExtension) {
    els.retreatStatusText.textContent = "Extension context unavailable.";
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_RETREAT_STATUS" });
    if (!response?.ok || !response.data) {
      els.retreatStatusText.textContent = "Unable to retrieve status.";
      return;
    }
    const { config, remaining, todayKey, alreadyTriggered } = response.data;
    if (!config.enabled) {
      els.retreatStatusText.textContent = "Disabled.";
      return;
    }
    if (!remaining) {
      els.retreatStatusText.textContent = "Non-working day or no target set for today.";
      return;
    }
    if (remaining.minutes > 0) {
      const h = Math.floor(remaining.minutes / 60);
      const m = remaining.minutes % 60;
      const timeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
      els.retreatStatusText.textContent = `Time remaining: ${timeStr} (target: ${remaining.targetTime})`;
    } else {
      els.retreatStatusText.textContent = alreadyTriggered
        ? "Time is up! Alert already triggered."
        : "Time is up! Ready to retreat.";
    }
  } catch {
    els.retreatStatusText.textContent = "Unable to connect to background service.";
  }
}
