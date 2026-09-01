const DEFAULT_SETTINGS = {
  copyToClipboard: true,
  downloadPng: true,
  captureMode: "visible"
};

const copyToggle = document.querySelector("#copyToClipboard");
const downloadToggle = document.querySelector("#downloadPng");
const startButton = document.querySelector("#start");
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
