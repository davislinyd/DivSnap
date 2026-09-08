importScripts("i18n.js");
const t = (...args) => DivSnapI18n.t(...args);
const languageReady = DivSnapI18n.load().catch(() => {});

const DEFAULT_SETTINGS = {
  copyToClipboard: true,
  downloadEnabled: true,
  captureMode: "visible",
  imageFormat: "png",
  language: "zh-Hant"
};

const controller = {
  boundTabId: null,
  boundFrameId: 0,
  documentToken: null,
  sessionId: null,
  captureId: null,
  controlPort: null,
  initialized: false
};

chrome.runtime.onInstalled.addListener(() => {
  migrateSettings().catch((error) => console.error("DivSnap settings migration failed", error));
});

chrome.action.onClicked.addListener((tab) => {
  languageReady.then(() => openControlPanel(tab?.id)).catch((error) => console.error("DivSnap panel failed", error));
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "start-inspect") return;
  languageReady.then(() => chrome.tabs.query({active: true, lastFocusedWindow: true})).then(([tab]) => {
    if (tab?.id !== undefined) return openControlPanel(tab.id, true);
    throw new Error(t("activeTabMissing"));
  }).catch((error) => console.error("DivSnap start failed", error));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  restoreController().then(() => {
    if (tabId !== controller.boundTabId) return;
    clearController();
  }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  restoreController().then(() => {
    if (tabId !== controller.boundTabId || changeInfo.status !== "loading") return;
    controller.documentToken = null;
    controller.captureId = null;
    persistController().catch(() => {});
    notifyControl({type: "CONTROL_TARGET_LOADING", tabId});
  }).catch(() => {});
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "divsnap-control") return;
  port.onMessage.addListener((message) => {
    handleControlMessage(port, message).catch((error) => reply(port, message, {ok: false, error: formatError(error)}));
  });
  port.onDisconnect.addListener(() => {
    if (controller.controlPort === port) controller.controlPort = null;
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "INSPECT_STATE" || message?.type === "CAPTURE_RESULT" || message?.type === "CAPTURE_REQUEST") {
    const delivered = handleContentMessage(message, sender);
    if (message.type === "CAPTURE_REQUEST") sendResponse({ok: delivered});
    return false;
  }

  if (message?.type === "CAPTURE_VISIBLE") {
    captureVisible(message, sender).then((dataUrl) => sendResponse({ok: true, dataUrl})).catch((error) => sendResponse({ok: false, error: formatError(error)}));
    return true;
  }

  if (message?.type === "PANEL_CLOSED") {
    handlePanelClosed(message, sender);
    return false;
  }

  if (message?.type === "DIRECTORY_UPDATED") {
    handleDirectoryUpdated(message, sender).then(() => sendResponse({ok: true})).catch((error) => sendResponse({ok: false, error: formatError(error)}));
    return true;
  }

  return false;
});

async function migrateSettings() {
  const stored = await chrome.storage.sync.get({...DEFAULT_SETTINGS, downloadPng: undefined});
  const next = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (stored[key] === undefined) next[key] = key === "downloadEnabled" && stored.downloadPng !== undefined ? Boolean(stored.downloadPng) : value;
  }
  if (Object.keys(next).length) await chrome.storage.sync.set(next);
  if (stored.downloadPng !== undefined) await chrome.storage.sync.remove("downloadPng");
}

async function openControlPanel(targetTabId, autoStart = false) {
  await languageReady;
  await restoreController();
  if (!Number.isInteger(targetTabId)) throw new Error(t("activeTabMissing"));
  const tab = await chrome.tabs.get(targetTabId);
  if (tab.url && !isInspectableUrl(tab.url)) throw new Error(t("pageUnavailable"));

  if (!autoStart && controller.boundTabId === targetTabId && controller.sessionId && controller.documentToken) {
    await stopAndCloseBoundPanel();
    clearController();
    return;
  }

  const switchingTab = controller.boundTabId !== targetTabId;
  if (switchingTab) await stopAndCloseBoundPanel();
  if (switchingTab || !controller.sessionId || !controller.documentToken) {
    controller.boundTabId = targetTabId;
    controller.boundFrameId = 0;
    controller.sessionId = createId("session");
    controller.documentToken = null;
    controller.captureId = null;
    controller.controlPort = null;
    await persistController();
  }

  await ensureContentScript(targetTabId);
  let response = await sendPanelCommand(targetTabId, "OPEN_PANEL");
  if (!response?.ok) throw new Error(response?.error || t("panelOpenFailed"));
  if (controller.documentToken && response.documentToken !== controller.documentToken) {
    controller.sessionId = createId("session");
    controller.documentToken = null;
    controller.captureId = null;
    await persistController();
    response = await sendPanelCommand(targetTabId, "OPEN_PANEL");
    if (!response?.ok) throw new Error(response?.error || t("panelRecreateFailed"));
  }
  controller.documentToken = response.documentToken;
  await persistController();
  await sendPanelCommand(targetTabId, "FOCUS_PANEL");
  if (autoStart) await sendInspectCommand({command: "START"});
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({target: {tabId, frameIds: [0]}, files: ["i18n.js", "content.js"]});
}

async function stopAndCloseBoundPanel() {
  if (controller.boundTabId === null) return;
  const tabId = controller.boundTabId;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "INSPECT_COMMAND",
      command: "STOP",
      sessionId: controller.sessionId,
      documentToken: controller.documentToken
    });
  } catch {
    // The old page may already be navigating or closed.
  }
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "CLOSE_PANEL",
      sessionId: controller.sessionId,
      documentToken: controller.documentToken
    });
  } catch {
    // The old content script may already be gone.
  }
  controller.controlPort?.disconnect();
  controller.controlPort = null;
}

async function sendPanelCommand(tabId, type) {
  return chrome.tabs.sendMessage(tabId, {
    type,
    sessionId: controller.sessionId,
    documentToken: controller.documentToken,
    tabId
  });
}

async function handleControlMessage(port, message) {
  await languageReady;
  if (!message?.type) return;
  if (message.type === "CONTROL_READY") {
    const result = await handleControlReady(port, message);
    reply(port, message, result);
    return;
  }
  if (message.type === "INSPECT_COMMAND") {
    const result = await handleInspectCommand(port, message);
    reply(port, message, result);
    return;
  }
  if (message.type === "OPEN_DIRECTORY_SETTINGS") {
    const result = await openDirectorySettings(port, message);
    reply(port, message, result);
    return;
  }
  if (message.type === "DOWNLOAD_IMAGE") {
    const result = await handleDownload(port, message);
    reply(port, message, {ok: true, downloadId: result});
    return;
  }
  if (message.type === "WRITE_DIRECTORY") {
    const filename = await writeDirectory(port, message);
    reply(port, message, {ok: true, filename});
  }
}

async function handleControlReady(port, message) {
  await restoreController();
  if (!isControlIdentity(message)) throw new Error(t("sessionChanged"));
  controller.controlPort = port;
  port.__divsnapReady = true;
  port.__divsnapIdentity = {
    tabId: message.tabId,
    sessionId: message.sessionId,
    documentToken: message.documentToken
  };
  notifyControl({type: "CONTROL_BINDING", bound: true, tabId: controller.boundTabId, sessionId: controller.sessionId});
  requestTargetState();
  return {
    ok: true,
    boundTabId: controller.boundTabId,
    sessionId: controller.sessionId,
    documentToken: controller.documentToken,
    directory: await directoryMetadata()
  };
}

async function handleInspectCommand(port, message) {
  assertControlPort(port);
  if (message.sessionId !== controller.sessionId) throw new Error(t("sessionChanged"));
  if (controller.boundTabId === null) throw new Error(t("noBoundTab"));
  if (message.command === "CAPTURE") {
    if (typeof message.captureId !== "string" || !message.captureId) throw new Error("Capture operation is missing.");
    controller.captureId = message.captureId;
    await persistController();
  }
  return sendInspectCommand(message);
}

async function sendInspectCommand(message) {
  const tabId = controller.boundTabId;
  if (tabId === null) throw new Error(t("targetTabMissing"));
  if (message.command === "START") await ensureContentScript(tabId);
  const response = await chrome.tabs.sendMessage(tabId, {
    type: "INSPECT_COMMAND",
    command: message.command,
    sessionId: controller.sessionId,
    documentToken: controller.documentToken,
    key: message.key,
    index: message.index,
    targets: message.targets,
    settings: message.settings,
    captureId: message.captureId
  });
  if (response?.ok === false) throw new Error(response.error || "Inspector command failed.");
  return {ok: true};
}

function requestTargetState() {
  if (controller.boundTabId === null || controller.sessionId === null) return;
  chrome.tabs.sendMessage(controller.boundTabId, {
    type: "INSPECT_COMMAND",
    command: "GET_STATE",
    sessionId: controller.sessionId,
    documentToken: controller.documentToken
  }).catch(() => {});
}

function handleContentMessage(message, sender) {
  if (sender.tab?.id !== controller.boundTabId || sender.frameId !== controller.boundFrameId) return false;
  if (message.sessionId !== controller.sessionId) return false;
  if (!message.documentToken || (controller.documentToken && message.documentToken !== controller.documentToken)) return false;
  if (!controller.documentToken) {
    controller.documentToken = message.documentToken;
    persistController().catch(() => {});
  }
  if (message.type === "CAPTURE_RESULT" && message.captureId !== controller.captureId) return false;
  const delivered = notifyControl({...message, tabId: sender.tab.id, frameId: sender.frameId});
  if (message.type === "CAPTURE_RESULT") {
    controller.captureId = null;
    persistController().catch(() => {});
  }
  return delivered;
}

async function captureVisible(message, sender) {
  if (sender.tab?.id !== controller.boundTabId || sender.frameId !== controller.boundFrameId || message.sessionId !== controller.sessionId || message.documentToken !== controller.documentToken || message.captureId !== controller.captureId) {
    throw new Error("Capture session is no longer active.");
  }
  const target = await chrome.tabs.get(controller.boundTabId);
  if (!target.active) await chrome.tabs.update(controller.boundTabId, {active: true});
  return chrome.tabs.captureVisibleTab(target.windowId, {format: "png"});
}

async function handleDownload(port, message) {
  assertControlPort(port);
  const mimeType = message.mimeType === "image/webp" ? "image/webp" : "image/png";
  const base64 = message.bufferBase64;
  if (typeof base64 !== "string" || base64.length < 8) throw new Error("Image data is missing or empty.");
  return chrome.downloads.download({
    url: `data:${mimeType};base64,${base64}`,
    filename: message.filename || `divsnap.${mimeType === "image/webp" ? "webp" : "png"}`,
    saveAs: false,
    conflictAction: "uniquify"
  });
}

async function writeDirectory(port, message) {
  assertControlPort(port);
  const handle = await readDirectoryHandle();
  if (!handle) throw new Error(t("directoryNotSelected"));
  const permission = await directoryPermission(handle);
  if (permission !== "granted") throw new Error(t("directoryExpired"));
  const base64 = message.bufferBase64;
  if (typeof base64 !== "string" || base64.length < 8) throw new Error("Image data is missing or empty.");
  const mimeType = message.mimeType === "image/webp" ? "image/webp" : "image/png";
  const filename = await findAvailableFilename(handle, message.filename || `divsnap.${mimeType === "image/webp" ? "webp" : "png"}`);
  const file = await handle.getFileHandle(filename, {create: true});
  const writable = await file.createWritable();
  try {
    await writable.write(new Blob([base64ToBytes(base64)], {type: mimeType}));
  } finally {
    await writable.close();
  }
  return filename;
}

async function openDirectorySettings(port, message) {
  assertControlPort(port);
  const url = new URL(chrome.runtime.getURL("settings/directory.html"));
  url.searchParams.set("targetTabId", String(controller.boundTabId));
  url.searchParams.set("sessionId", controller.sessionId);
  url.searchParams.set("documentToken", controller.documentToken);
  url.searchParams.set("mode", message.mode === "reauthorize" ? "reauthorize" : "choose");
  const tab = await chrome.tabs.create({url: url.href, active: true});
  return {ok: true, settingsTabId: tab.id};
}

async function handleDirectoryUpdated(message, sender) {
  if (message.targetTabId !== controller.boundTabId || message.sessionId !== controller.sessionId || message.documentToken !== controller.documentToken) return;
  const directory = await directoryMetadata();
  notifyControl({
    type: "DIRECTORY_UPDATED",
    ...directory
  });
  chrome.tabs.update(controller.boundTabId, {active: true}).catch(() => {});
  if (sender.tab?.id !== undefined) chrome.tabs.remove(sender.tab.id).catch(() => {});
}

async function directoryMetadata() {
  const handle = await readDirectoryHandle();
  if (!handle) return {selected: false, name: "", permission: "none"};
  return {selected: true, name: handle.name || t("directoryNone"), permission: await directoryPermission(handle)};
}

async function directoryPermission(handle) {
  try {
    return handle.queryPermission ? await handle.queryPermission({mode: "readwrite"}) : "prompt";
  } catch {
    return "denied";
  }
}

function readDirectoryHandle() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("divsnap-directory", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("handles")) request.result.createObjectStore("handles");
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const get = database.transaction("handles", "readonly").objectStore("handles").get("directory");
      get.onsuccess = () => { database.close(); resolve(get.result || null); };
      get.onerror = () => { database.close(); reject(get.error); };
    };
  });
}

async function findAvailableFilename(handle, filename) {
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = index ? `${base} (${index})${extension}` : filename;
    try {
      await handle.getFileHandle(candidate);
    } catch (error) {
      if (error?.name === "NotFoundError") return candidate;
      throw error;
    }
  }
  throw new Error(t("filenameUnavailable"));
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function handlePanelClosed(message, sender) {
  if (sender.tab?.id !== controller.boundTabId || message.sessionId !== controller.sessionId || message.documentToken !== controller.documentToken) return;
  controller.controlPort?.disconnect();
  controller.controlPort = null;
  controller.boundTabId = null;
  controller.boundFrameId = 0;
  controller.documentToken = null;
  controller.sessionId = null;
  controller.captureId = null;
  persistController().catch(() => {});
}

function notifyControl(message) {
  if (!controller.controlPort || !controller.controlPort.__divsnapReady) return false;
  try {
    controller.controlPort.postMessage(message);
    return true;
  } catch {
    controller.controlPort = null;
    return false;
  }
}

function reply(port, message, response) {
  if (!message?.requestId) return;
  try {
    port.postMessage({type: "COMMAND_RESULT", requestId: message.requestId, ...response});
  } catch {
    // The iframe may have been closed while the command was running.
  }
}

function assertControlPort(port) {
  if (controller.controlPort !== port || !port.__divsnapReady) throw new Error(t("controlDisconnected"));
}

function isControlIdentity(message) {
  return Number.isInteger(message.tabId) && message.tabId === controller.boundTabId && message.sessionId === controller.sessionId && message.documentToken === controller.documentToken;
}

async function restoreController() {
  if (controller.initialized) return;
  const stored = await chrome.storage.session.get({divsnapController: {}}).catch(() => ({divsnapController: {}}));
  Object.assign(controller, stored.divsnapController || {});
  controller.controlPort = null;
  controller.captureId = null;
  controller.initialized = true;
  persistController().catch(() => {});
}

function persistController() {
  return chrome.storage.session.set({divsnapController: {
    boundTabId: controller.boundTabId,
    boundFrameId: controller.boundFrameId,
    documentToken: controller.documentToken,
    sessionId: controller.sessionId,
    captureId: controller.captureId
  }});
}

function clearController() {
  controller.controlPort?.disconnect();
  controller.controlPort = null;
  controller.boundTabId = null;
  controller.boundFrameId = 0;
  controller.documentToken = null;
  controller.sessionId = null;
  controller.captureId = null;
  persistController().catch(() => {});
}

function isInspectableUrl(url) {
  return /^(https?|file):/i.test(url || "");
}

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatError(error) {
  return error?.message || String(error);
}
