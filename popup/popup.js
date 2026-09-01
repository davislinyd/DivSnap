const DEFAULT_SETTINGS = {
  copyToClipboard: true,
  downloadPng: true,
  captureMode: "visible"
};

const copyToggle = document.querySelector("#copyToClipboard");
const downloadToggle = document.querySelector("#downloadPng");
const startButton = document.querySelector("#start");
const shortcutBadge = document.querySelector("#shortcut-badge");
const shortcutValue = document.querySelector("#shortcut-value");
const shortcutSettingsButton = document.querySelector("#shortcut-settings");
const message = document.querySelector("#message");

init();

async function init() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  copyToggle.checked = settings.copyToClipboard;
  downloadToggle.checked = settings.downloadPng;
  document.querySelector(`input[name="captureMode"][value="${settings.captureMode === "full" ? "full" : "visible"}"]`).checked = true;
  copyToggle.addEventListener("change", persist);
  downloadToggle.addEventListener("change", persist);
  document.querySelectorAll('input[name="captureMode"]').forEach((input) => input.addEventListener("change", persist));
  startButton.addEventListener("click", startInspect);
  shortcutSettingsButton.addEventListener("click", openShortcutSettings);
  renderShortcut(await getStartShortcut());
}

async function persist() {
  await chrome.storage.sync.set({
    copyToClipboard: copyToggle.checked,
    downloadPng: downloadToggle.checked,
    captureMode: document.querySelector('input[name="captureMode"]:checked').value
  });
}

function startInspect() {
  startButton.disabled = true;
  message.textContent = "Starting / 啟動中…";
  chrome.runtime.sendMessage({type: "START_INSPECT"}, (response) => {
    const error = chrome.runtime.lastError;
    if (error || !response?.ok) {
      startButton.disabled = false;
      message.textContent = `Cannot inspect / 無法檢查：${error?.message || response?.error || "Unknown error"}`;
      return;
    }
    window.close();
  });
}

async function getStartShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    return commands.find((command) => command.name === "start-inspect")?.shortcut?.trim() || "";
  } catch {
    return "";
  }
}

function renderShortcut(shortcut) {
  const label = shortcut ? formatShortcut(shortcut) : "未設定";
  const accessibleLabel = `目前快捷鍵：${shortcut || "未設定"}`;
  shortcutBadge.textContent = label;
  shortcutValue.textContent = label;
  shortcutBadge.title = shortcut || "未設定";
  shortcutValue.title = shortcut || "未設定";
  shortcutBadge.setAttribute("aria-label", accessibleLabel);
  shortcutValue.setAttribute("aria-label", accessibleLabel);
}

function formatShortcut(shortcut) {
  const isMac = /Mac/i.test(navigator.platform) || /Mac/i.test(navigator.userAgent);
  if (!isMac) return shortcut;
  return shortcut
    .replaceAll("MacCtrl", "⌃")
    .replaceAll("Command", "⌘")
    .replaceAll("Ctrl", "⌃")
    .replaceAll("Alt", "⌥")
    .replaceAll("Option", "⌥")
    .replaceAll("Shift", "⇧")
    .replaceAll("+", "");
}

function openShortcutSettings() {
  try {
    chrome.tabs.create({url: "chrome://extensions/shortcuts"}, () => {
      const error = chrome.runtime.lastError;
      if (error) message.textContent = `Cannot open shortcut settings / 無法開啟快捷鍵設定：${error.message}`;
    });
  } catch (error) {
    message.textContent = `Cannot open shortcut settings / 無法開啟快捷鍵設定：${error.message || String(error)}`;
  }
}
