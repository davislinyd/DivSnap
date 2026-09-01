const DEFAULT_SETTINGS = {
  copyToClipboard: true,
  downloadPng: true,
  captureMode: "visible"
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULT_SETTINGS).then((stored) => {
    const missing = {};
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (stored[key] === undefined) missing[key] = value;
    }
    if (Object.keys(missing).length) chrome.storage.sync.set(missing);
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "start-inspect") return;
  chrome.tabs.query({active: true, lastFocusedWindow: true}).then(([tab]) => {
    if (tab?.id !== undefined) {
      startInspect(tab.id).catch((error) => console.error("DivSnap start failed", error));
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_INSPECT") {
    const tabPromise = message.tabId !== undefined
      ? Promise.resolve({id: message.tabId})
      : sender.tab?.id !== undefined
        ? Promise.resolve({id: sender.tab.id})
        : chrome.tabs.query({active: true, lastFocusedWindow: true}).then(([tab]) => tab);
    tabPromise.then((tab) => {
      if (tab?.id === undefined) throw new Error("找不到目前分頁 / Active tab unavailable.");
      return startInspect(tab.id);
    }).then(() => sendResponse({ok: true})).catch((error) => {
      sendResponse({ok: false, error: formatError(error)});
    });
    return true;
  }

  if (message?.type === "CAPTURE_VISIBLE") {
    const windowId = sender.tab?.windowId;
    chrome.tabs.captureVisibleTab(windowId, {format: "png"})
      .then((dataUrl) => sendResponse({ok: true, dataUrl}))
      .catch((error) => sendResponse({ok: false, error: formatError(error)}));
    return true;
  }

  if (message?.type === "DOWNLOAD_PNG") {
    downloadPng(message, sender)
      .then((downloadId) => sendResponse({ok: true, downloadId}))
      .catch((error) => sendResponse({ok: false, error: formatError(error)}));
    return true;
  }

  return false;
});

async function startInspect(tabId) {
  await chrome.scripting.executeScript({
    target: {tabId},
    files: ["content.js"]
  });
  const response = await chrome.tabs.sendMessage(tabId, {type: "START_INSPECT"});
  if (!response?.ok) throw new Error(response?.error || "Inspector could not start.");
}

async function downloadPng(message, sender) {
  const base64 = message.bufferBase64 || arrayBufferToBase64(message.buffer);
  if (!base64 || base64.length < 8) throw new Error("PNG data is missing or empty.");

  return chrome.downloads.download({
    url: `data:image/png;base64,${base64}`,
    filename: message.filename || "divsnap.png",
    saveAs: false,
    conflictAction: "uniquify"
  });
}

function arrayBufferToBase64(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return bytesToBase64(new Uint8Array(value));
  if (value instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return "";
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function formatError(error) {
  return error?.message || String(error);
}
