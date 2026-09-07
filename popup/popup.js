const DEFAULT_SETTINGS = {
  copyToClipboard: true,
  downloadEnabled: true,
  captureMode: "visible",
  imageFormat: "png"
};

const state = {
  controller: {boundTabId: null, sessionId: null},
  inspector: null,
  profiles: [],
  currentProfileId: "",
  pageKey: "",
  directory: {selected: false, name: "", permission: "none"},
  settings: {...DEFAULT_SETTINGS},
  pendingCapture: null,
  lastCapture: null,
  lastOutput: null,
  outputBusy: false,
  shortcut: ""
};

const panelContext = {
  tabId: Number(new URLSearchParams(location.search).get("tabId")),
  sessionId: new URLSearchParams(location.search).get("sessionId") || "",
  documentToken: new URLSearchParams(location.search).get("documentToken") || ""
};

let controlPort = null;
let reconnectTimer = null;
const pendingCommands = new Map();

const elements = {
  version: document.querySelector("#version"),
  shortcutSettings: document.querySelector("#shortcut-settings"),
  shortcutLabel: document.querySelector("#shortcut-label"),
  boundPage: document.querySelector("#bound-page"),
  connectionStatus: document.querySelector("#connection-status"),
  connectionDot: document.querySelector("#connection-dot"),
  profileSelect: document.querySelector("#profile-select"),
  loadProfile: document.querySelector("#load-profile"),
  profileName: document.querySelector("#profile-name"),
  newProfile: document.querySelector("#new-profile"),
  updateProfile: document.querySelector("#update-profile"),
  renameProfile: document.querySelector("#rename-profile"),
  deleteProfile: document.querySelector("#delete-profile"),
  profileHint: document.querySelector("#profile-hint"),
  profileIssues: document.querySelector("#profile-issues"),
  toggleInspect: document.querySelector("#toggle-inspect"),
  unlock: document.querySelector("#unlock"),
  undo: document.querySelector("#undo"),
  clear: document.querySelector("#clear"),
  candidates: document.querySelector("#candidates"),
  parent: document.querySelector("#parent"),
  child: document.querySelector("#child"),
  toggleCurrent: document.querySelector("#toggle-current"),
  selectionStatus: document.querySelector("#selection-status"),
  selectionCount: document.querySelector("#selection-count"),
  selectionList: document.querySelector("#selection-list"),
  copyToClipboard: document.querySelector("#copyToClipboard"),
  downloadEnabled: document.querySelector("#downloadEnabled"),
  chooseDirectory: document.querySelector("#choose-directory"),
  reauthorizeDirectory: document.querySelector("#reauthorize-directory"),
  directoryName: document.querySelector("#directory-name"),
  directoryStatus: document.querySelector("#directory-status"),
  capture: document.querySelector("#capture"),
  progress: document.querySelector("#progress"),
  result: document.querySelector("#result"),
  retryCopy: document.querySelector("#retry-copy"),
  retryOutput: document.querySelector("#retry-output"),
  message: document.querySelector("#message")
};

init().catch((error) => setMessage(`初始化失敗：${formatError(error)}`));

function handlePortMessage(message) {
  if (message?.type === "COMMAND_RESULT") {
    const pending = pendingCommands.get(message.requestId);
    if (!pending) return;
    pendingCommands.delete(message.requestId);
    if (message.ok === false) pending.reject(new Error(message.error || "控制面板命令失敗。"));
    else pending.resolve(message);
    return;
  }
  if (message?.documentToken && message.documentToken !== panelContext.documentToken) return;
  if (message?.type === "CONTROL_BINDING") {
    const bindingChanged = message.bound && (message.tabId !== state.controller.boundTabId || message.sessionId !== state.controller.sessionId);
    if (!message.bound || bindingChanged) cancelPendingCapture(message.bound ? "已切換目標分頁，上一個擷取已取消。" : "目標分頁已關閉，擷取已取消。", "warning");
    if (bindingChanged || !message.bound) {
      state.inspector = null;
      state.pageKey = "";
      state.currentProfileId = "";
    }
    state.controller.boundTabId = message.bound ? message.tabId : null;
    if (message.sessionId !== undefined) state.controller.sessionId = message.sessionId;
    render();
    loadProfiles().catch((error) => setMessage(`Profile 讀取失敗：${formatError(error)}`));
  } else if (message?.type === "CONTROL_TARGET_LOADING") {
    cancelPendingCapture("目標分頁正在重新載入，擷取已取消。", "warning");
    state.inspector = null;
    state.pageKey = "";
    state.currentProfileId = "";
    setMessage("目標分頁正在重新載入，請等待狀態更新。", "warning");
    render();
  } else if (message?.type === "INSPECT_STATE") {
    if (message.sessionId !== state.controller.sessionId) return;
    const oldPageKey = state.pageKey;
    state.inspector = message;
    state.pageKey = message.page?.pageKey || "";
    if (state.outputBusy && state.pendingCapture && !message.busy && /Capture failed|截圖失敗/.test(message.status || "")) {
      state.pendingCapture = null;
      state.outputBusy = false;
      elements.progress.textContent = "準備就緒";
      setMessage(message.status, "error");
    }
    if (oldPageKey !== state.pageKey) loadProfiles().catch((error) => setMessage(`Profile 讀取失敗：${formatError(error)}`));
    render();
  } else if (message?.type === "CAPTURE_RESULT") {
    if (message.sessionId !== state.controller.sessionId) return;
    handleCaptureResult(message).catch((error) => {
      state.outputBusy = false;
      elements.progress.textContent = "準備就緒";
      setMessage(`輸出失敗：${formatError(error)}`);
      render();
    });
  } else if (message?.type === "CAPTURE_REQUEST") {
    requestCapture(true);
  } else if (message?.type === "DIRECTORY_UPDATED") {
    applyDirectory(message);
    setMessage(message.permission === "granted" ? "資料夾已更新。" : "資料夾權限仍未授予。", message.permission === "granted" ? "info" : "warning");
    render();
  }
}

function connectControl() {
  if (controlPort) return;
  const port = chrome.runtime.connect({name: "divsnap-control"});
  controlPort = port;
  port.onMessage.addListener(handlePortMessage);
  port.onDisconnect.addListener(() => {
    if (controlPort !== port) return;
    for (const pending of pendingCommands.values()) pending.reject(new Error("控制面板連線已中斷。"));
    pendingCommands.clear();
    controlPort = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      rehandshake().catch(() => {});
    }, 250);
  });
}

async function rehandshake() {
  if (controlPort || window.parent === window) return;
  connectControl();
  const response = await sendMessage({type: "CONTROL_READY", tabId: panelContext.tabId, sessionId: panelContext.sessionId, documentToken: panelContext.documentToken});
  if (!response?.ok) throw new Error(response?.error || "頁內面板連線失敗。");
  state.controller.boundTabId = response.boundTabId ?? null;
  state.controller.sessionId = response.sessionId ?? null;
  applyDirectory(response.directory);
  await sendInspectCommand("GET_STATE").catch(() => {});
  render();
}

async function init() {
  elements.version.textContent = chrome.runtime.getManifest().version;
  bindEvents();
  await initPanelLayout();
  connectControl();
  await loadSettings();
  const response = await sendMessage({type: "CONTROL_READY", tabId: panelContext.tabId, sessionId: panelContext.sessionId, documentToken: panelContext.documentToken});
  if (!response?.ok) throw new Error(response?.error || "頁內面板連線失敗。 ");
  state.controller.boundTabId = response.boundTabId ?? null;
  state.controller.sessionId = response.sessionId ?? null;
  applyDirectory(response.directory);
  state.shortcut = await getStartShortcut();
  await loadProfiles();
  await sendInspectCommand("GET_STATE").catch(() => {});
  render();
}

function bindEvents() {
  document.querySelector("#panel-close").addEventListener("click", () => postPanelMessage({type: "DIVSNAP_PANEL_CLOSE"}));
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== new URL(chrome.runtime.getURL("/")).origin) return;
    if (event.data?.type !== "DIVSNAP_PANEL_COLLAPSED") return;
    document.body.dataset.panelCollapsed = event.data.collapsed ? "true" : "false";
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.repeat) return;
    event.preventDefault();
    postPanelMessage({type: "DIVSNAP_PANEL_ESCAPE"});
  });
  document.addEventListener("keydown", (event) => {
    if (event.repeat) return;
    const target = event.target;
    const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
    if (editing) return;
    const key = String(event.key || "");
    const undo = (event.ctrlKey || event.metaKey) && !event.shiftKey && key.toLowerCase() === "z";
    const clearChord = !event.ctrlKey && !event.metaKey && !event.altKey && key.toLowerCase() === "d";
    if (!undo && !clearChord) return;
    event.preventDefault();
    postPanelMessage({
      type: "DIVSNAP_PANEL_KEYDOWN",
      key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat
    });
  });
  elements.toggleInspect.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.repeat || !state.inspector?.running || state.inspector.paused) return;
    event.preventDefault();
    postPanelMessage({type: "DIVSNAP_PANEL_ENTER"});
  });
  document.addEventListener("pointerdown", () => reportPanelFocus(false));
  document.addEventListener("keydown", () => reportPanelFocus(true));
  window.addEventListener("focus", refreshShortcut);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshShortcut();
  });
  elements.shortcutSettings.addEventListener("click", openShortcutSettings);
  elements.toggleInspect.addEventListener("click", toggleInspect);
  elements.unlock.addEventListener("click", () => sendInspectCommand("UNLOCK"));
  elements.undo.addEventListener("click", () => sendInspectCommand("UNDO"));
  elements.clear.addEventListener("click", () => sendInspectCommand("CLEAR"));
  elements.parent.addEventListener("click", () => sendInspectCommand("NAVIGATE", {key: "ArrowUp"}));
  elements.child.addEventListener("click", () => sendInspectCommand("NAVIGATE", {key: "ArrowDown"}));
  elements.toggleCurrent.addEventListener("click", () => sendInspectCommand("TOGGLE"));
  elements.candidates.addEventListener("change", () => sendInspectCommand("SELECT_CANDIDATE", {index: Number(elements.candidates.value)}));
  elements.profileSelect.addEventListener("change", () => {
    state.currentProfileId = elements.profileSelect.value;
    const profile = currentProfiles().find((item) => item.id === state.currentProfileId);
    if (profile) loadSelectedProfile(profile).catch((error) => setMessage(formatError(error)));
    render();
  });
  elements.loadProfile.addEventListener("click", () => {
    const profile = currentProfiles().find((item) => item.id === elements.profileSelect.value);
    if (profile) loadSelectedProfile(profile).catch((error) => setMessage(formatError(error)));
  });
  elements.newProfile.addEventListener("click", createProfile);
  elements.updateProfile.addEventListener("click", updateProfile);
  elements.renameProfile.addEventListener("click", renameProfile);
  elements.deleteProfile.addEventListener("click", deleteProfile);
  elements.copyToClipboard.addEventListener("change", persistSettings);
  elements.downloadEnabled.addEventListener("change", persistSettings);
  document.querySelectorAll('input[name="captureMode"], input[name="imageFormat"]').forEach((input) => input.addEventListener("change", persistSettings));
  elements.chooseDirectory.addEventListener("click", chooseDirectory);
  elements.reauthorizeDirectory.addEventListener("click", reauthorizeDirectory);
  elements.capture.addEventListener("click", () => requestCapture(true));
  elements.retryCopy.addEventListener("click", () => retryOutput("copy"));
  elements.retryOutput.addEventListener("click", () => retryOutput("download"));
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get({...DEFAULT_SETTINGS, downloadPng: undefined});
  state.settings = {
    copyToClipboard: stored.copyToClipboard === undefined ? DEFAULT_SETTINGS.copyToClipboard : Boolean(stored.copyToClipboard),
    downloadEnabled: stored.downloadEnabled === undefined ? stored.downloadPng !== undefined ? Boolean(stored.downloadPng) : DEFAULT_SETTINGS.downloadEnabled : Boolean(stored.downloadEnabled),
    captureMode: stored.captureMode === "full" ? "full" : "visible",
    imageFormat: stored.imageFormat === "webp" ? "webp" : "png"
  };
  elements.copyToClipboard.checked = state.settings.copyToClipboard;
  elements.downloadEnabled.checked = state.settings.downloadEnabled;
  selectRadio("captureMode", state.settings.captureMode);
  selectRadio("imageFormat", state.settings.imageFormat);
  if (stored.downloadPng !== undefined) await chrome.storage.sync.remove("downloadPng");
}

async function persistSettings() {
  state.settings = {
    copyToClipboard: elements.copyToClipboard.checked,
    downloadEnabled: elements.downloadEnabled.checked,
    captureMode: document.querySelector('input[name="captureMode"]:checked').value,
    imageFormat: document.querySelector('input[name="imageFormat"]:checked').value
  };
  await chrome.storage.sync.set(state.settings);
  render();
}

async function toggleInspect() {
  const command = state.inspector?.running && !state.inspector?.paused ? "PAUSE" : "START";
  try {
    await sendInspectCommand(command, {settings: {captureMode: state.settings.captureMode}});
    clearMessage();
  } catch (error) {
    setMessage(formatError(error));
  }
}

async function loadSelectedProfile(profile) {
  if (!state.inspector?.running) await sendInspectCommand("START", {settings: {captureMode: state.settings.captureMode}});
  await sendInspectCommand("LOAD_PROFILE", {targets: profile.targets});
}

async function requestCapture(fromInspector = false) {
  if (!state.controller.sessionId || state.outputBusy || (!fromInspector && !state.inspector?.canCapture)) return;
  if (!state.settings.copyToClipboard && !state.settings.downloadEnabled) {
    setMessage("請至少開啟一種輸出方式。", "warning");
    return;
  }
  state.pendingCapture = {
    captureId: createId(),
    settings: {
      ...state.settings,
      directorySelected: state.directory.selected
    }
  };
  state.outputBusy = true;
  elements.progress.textContent = "正在擷取…";
  render();
  try {
    await sendInspectCommand("CAPTURE", {captureId: state.pendingCapture.captureId, settings: {captureMode: state.settings.captureMode}});
  } catch (error) {
    state.pendingCapture = null;
    state.outputBusy = false;
    elements.progress.textContent = "準備就緒";
    setMessage(formatError(error));
    render();
  }
}

async function handleCaptureResult(message) {
  if (state.pendingCapture?.captureId && state.pendingCapture.captureId !== message.captureId) return;
  if (message.ok === false) {
    state.pendingCapture = null;
    state.outputBusy = false;
    elements.progress.textContent = "準備就緒";
    setMessage(`截圖失敗：${message.error || "未知錯誤"}`, "error");
    render();
    return;
  }
  const pending = state.pendingCapture || {settings: {...state.settings, directorySelected: state.directory.selected}};
  state.pendingCapture = null;
  state.lastCapture = {...message, settings: pending.settings};
  state.lastOutput = null;
  await processCapture();
}

async function processCapture() {
  const capture = state.lastCapture;
  state.outputBusy = true;
  elements.progress.textContent = "正在處理輸出…";
  render();
  const settings = capture.settings;
  const pngBlob = base64ToBlob(capture.bufferBase64, "image/png");
  const output = {
    capture,
    settings,
    pngBlob,
    outputBlob: null,
    filename: `${capture.filenameBase || "divsnap"}.${settings.imageFormat === "webp" ? "webp" : "png"}`,
    failedCopy: Boolean(settings.copyToClipboard),
    failedDownload: Boolean(settings.downloadEnabled),
    messages: [...(capture.notices || [])]
  };
  state.lastOutput = output;
  if (settings.downloadEnabled) {
    try {
      output.outputBlob = settings.imageFormat === "webp" ? await encodeWebp(pngBlob) : pngBlob;
    } catch (error) {
      output.messages.push(`WebP 編碼失敗：${formatError(error)}`);
    }
  }
  await runOutput("copy");
  await runOutput("download");
  state.outputBusy = false;
  elements.progress.textContent = "準備就緒";
  renderOutput();
  render();
}

async function retryOutput(kind) {
  if (!state.lastOutput || state.outputBusy) return;
  state.outputBusy = true;
  elements.progress.textContent = kind === "copy" ? "正在複製…" : "正在重試儲存…";
  render();
  await runOutput(kind);
  state.outputBusy = false;
  elements.progress.textContent = "準備就緒";
  renderOutput();
  render();
}

async function runOutput(kind) {
  const output = state.lastOutput;
  if (!output) return;
  if (kind === "copy") {
    if (!output.settings.copyToClipboard || !output.failedCopy) return;
    try {
      await copyPng(output.pngBlob);
      output.failedCopy = false;
      output.messages = output.messages.filter((message) => !message.startsWith("剪貼簿"));
      output.messages.push("PNG 已複製到剪貼簿");
    } catch (error) {
      output.messages = output.messages.filter((message) => !message.startsWith("剪貼簿"));
      output.messages.push(`剪貼簿複製失敗：${formatError(error)}`);
    }
    return;
  }
  if (!output.settings.downloadEnabled || !output.failedDownload) return;
  if (!output.outputBlob) {
    output.messages = output.messages.filter((message) => !message.startsWith("WebP"));
    output.messages.push("WebP 編碼失敗，無法儲存。");
    return;
  }
  try {
    const filename = output.settings.directorySelected
      ? await writeToDirectory(output.filename, output.outputBlob)
      : await downloadFromBrowser(output.filename, output.outputBlob);
    output.failedDownload = false;
    output.messages = output.messages.filter((message) => !message.startsWith("儲存失敗") && !message.startsWith("下載失敗") && !message.startsWith("WebP"));
    output.messages.push(output.settings.directorySelected ? `已儲存 ${filename}` : "已送至瀏覽器 Downloads");
  } catch (error) {
    if (output.settings.directorySelected) state.directory.permission = "denied";
    output.messages = output.messages.filter((message) => !message.startsWith("儲存失敗") && !message.startsWith("下載失敗"));
    output.messages.push(`${output.settings.directorySelected ? "儲存" : "下載"}失敗：${formatError(error)}`);
  }
}

function render() {
  const inspector = state.inspector;
  renderShortcut(state.shortcut);
  const bound = Number.isInteger(state.controller.boundTabId);
  elements.boundPage.textContent = bound ? inspector?.page?.label || `Tab ${state.controller.boundTabId}` : "尚未綁定網頁分頁";
  elements.connectionStatus.textContent = !bound
    ? "請從網頁分頁點擊 DivSnap 圖示。"
    : !inspector?.running
      ? "已綁定；按「開始選取」啟動頁面事件攔截。"
      : inspector.paused
        ? "選取已暫停；本次選取仍保留。"
        : inspector.busy
          ? "正在擷取，請稍候。"
          : "已連線；頁面事件攔截中。";
  elements.connectionDot.dataset.state = inspector?.busy ? "busy" : bound && inspector?.running ? "ready" : "";
  elements.toggleInspect.textContent = inspector?.running && !inspector.paused ? "暫停選取" : inspector?.running ? "開始選取" : "開始選取";
  elements.toggleInspect.disabled = !bound || state.outputBusy;
  elements.unlock.disabled = !inspector?.locked || inspector?.busy;
  elements.undo.disabled = !inspector?.historyLength;
  elements.clear.disabled = !inspector?.selection?.length;
  elements.parent.disabled = !inspector?.current || inspector?.busy;
  elements.child.disabled = !inspector?.current || inspector?.busy;
  elements.toggleCurrent.disabled = !inspector?.current || inspector?.busy;
  renderCandidates();
  renderSelection();
  renderProfiles();
  renderProfileIssues();
  renderDirectory();
  elements.capture.disabled = state.outputBusy || !inspector?.canCapture || (!state.settings.copyToClipboard && !state.settings.downloadEnabled);
  if (!state.outputBusy && !state.lastOutput) elements.progress.textContent = inspector?.busy ? "正在擷取…" : "準備就緒";
  renderOutput();
}

function renderCandidates() {
  const candidates = state.inspector?.candidates || [];
  elements.candidates.replaceChildren(...(candidates.length ? candidates : [{label: "尚未開始選取"}]).map((candidate, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = candidate.label;
    return option;
  }));
  elements.candidates.disabled = !candidates.length || Boolean(state.inspector?.busy);
  if (candidates.length && state.inspector.currentIndex >= 0) elements.candidates.value = String(state.inspector.currentIndex);
}

function renderSelection() {
  const selection = state.inspector?.selection || [];
  elements.selectionCount.textContent = `${selection.length} 項`;
  elements.selectionStatus.textContent = state.inspector?.status || (selection.length ? "已保留選取。" : "鎖定預覽或用 Shift＋點擊加入元素。");
  elements.selectionList.replaceChildren(...(selection.length ? selection.map((item, index) => {
    const row = document.createElement("div");
    row.className = "selection-row";
    const label = document.createElement("span");
    label.textContent = `${item.valid ? "" : "失效 · "}${item.label}`;
    const remove = document.createElement("button");
    remove.className = "secondary-button";
    remove.type = "button";
    remove.textContent = "移除";
    remove.addEventListener("click", () => sendInspectCommand("REMOVE_SELECTION", {index}));
    row.append(label, remove);
    return row;
  }) : [emptyState("鎖定預覽或用 Shift＋點擊加入元素。")]));
}

function renderProfiles() {
  const profiles = currentProfiles();
  const current = profiles.some((profile) => profile.id === state.currentProfileId) ? state.currentProfileId : "";
  if (current !== state.currentProfileId) state.currentProfileId = current;
  elements.profileSelect.replaceChildren(...[new Option(profiles.length ? "選取 Profile" : "目前頁面沒有 Profile", ""), ...profiles.map((profile) => new Option(profile.name, profile.id))]);
  elements.profileSelect.value = state.currentProfileId;
  const hasProfile = Boolean(state.currentProfileId);
  elements.loadProfile.disabled = !hasProfile || !state.controller.sessionId;
  elements.renameProfile.disabled = !hasProfile;
  elements.deleteProfile.disabled = !hasProfile;
  elements.updateProfile.disabled = !hasProfile || !validSelectionDescriptors().length;
  elements.newProfile.disabled = !state.pageKey || !validSelectionDescriptors().length;
  elements.profileHint.textContent = state.inspector?.profileResolution?.length
    ? "已解析 Profile；問題項目需補選或明確略過。"
    : "載入後會先解析並預覽，不會自動截圖。";
}

function renderProfileIssues() {
  const issues = (state.inspector?.profileResolution || []).filter((item) => item.status !== "resolved");
  elements.profileIssues.replaceChildren(...issues.map((item) => {
    const row = document.createElement("div");
    row.className = "issue-row";
    const label = document.createElement("span");
    label.textContent = `${resolutionLabel(item.status)}：${item.label}`;
    const dismiss = document.createElement("button");
    dismiss.className = "danger-button";
    dismiss.type = "button";
    dismiss.textContent = "略過";
    dismiss.addEventListener("click", () => sendInspectCommand("DISMISS_PROFILE_TARGET", {index: item.index}));
    row.append(label, dismiss);
    return row;
  }));
}

function renderDirectory() {
  const directory = state.directory;
  elements.directoryName.textContent = directory.selected ? directory.name : "瀏覽器 Downloads";
  elements.directoryStatus.textContent = directory.selected
    ? directory.permission === "granted" ? "File System Access · 已授權" : directory.permission === "denied" ? "權限失效，請重新授權" : "需要重新授權後才能寫入"
    : "尚未選擇本機資料夾";
  elements.reauthorizeDirectory.hidden = !directory.selected || directory.permission === "granted";
}

function renderOutput() {
  const output = state.lastOutput;
  if (!output) {
    elements.result.textContent = "";
    elements.result.dataset.kind = "";
    elements.retryCopy.hidden = true;
    elements.retryOutput.hidden = true;
    return;
  }
  elements.result.textContent = output.messages.join(" · ");
  elements.result.dataset.kind = output.failedCopy || output.failedDownload ? "error" : "";
  elements.retryCopy.hidden = !output.failedCopy;
  elements.retryOutput.hidden = !output.failedDownload;
}

function renderShortcut(shortcut) {
  const label = shortcut ? `啟動選取：${formatShortcut(shortcut)}` : "啟動選取：未設定";
  elements.shortcutLabel.textContent = label;
  elements.shortcutLabel.title = shortcut || "啟動選取：未設定";
  elements.shortcutLabel.setAttribute("aria-label", `啟動選取快捷鍵：${shortcut || "未設定"}`);
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

async function createProfile() {
  const name = elements.profileName.value.trim();
  const targets = validSelectionDescriptors();
  if (!name) return setMessage("請先輸入 Profile 名稱。", "warning");
  if (!targets.length) return setMessage("請先選取至少一個有效元素。", "warning");
  const profile = {id: createId(), name, pageKey: state.pageKey, pageLabel: state.inspector?.page?.label || "目前頁面", targets, updatedAt: new Date().toISOString()};
  state.profiles.push(profile);
  state.currentProfileId = profile.id;
  await saveProfiles();
  elements.profileName.value = "";
  setMessage(`Profile「${name}」已新增。`, "info");
  render();
}

async function renameProfile() {
  const profile = selectedProfile();
  const name = elements.profileName.value.trim();
  if (!profile) return;
  if (!name) return setMessage("請先輸入新的 Profile 名稱。", "warning");
  profile.name = name;
  profile.updatedAt = new Date().toISOString();
  await saveProfiles();
  elements.profileName.value = "";
  setMessage(`Profile 已重新命名為「${name}」。`, "info");
  render();
}

async function updateProfile() {
  const profile = selectedProfile();
  const targets = validSelectionDescriptors();
  if (!profile) return;
  if (!targets.length) return setMessage("請先選取至少一個有效元素。", "warning");
  profile.targets = targets;
  profile.pageLabel = state.inspector?.page?.label || profile.pageLabel;
  profile.updatedAt = new Date().toISOString();
  await saveProfiles();
  await loadSelectedProfile(profile).catch((error) => setMessage(formatError(error)));
  setMessage(`Profile「${profile.name}」已更新。`, "info");
  render();
}

async function deleteProfile() {
  const profile = selectedProfile();
  if (!profile) return;
  if (!confirm(`刪除 Profile「${profile.name}」？`)) return;
  state.profiles = state.profiles.filter((item) => item.id !== profile.id);
  state.currentProfileId = "";
  await saveProfiles();
  await sendInspectCommand("CLEAR_PROFILE").catch(() => {});
  setMessage("Profile 已刪除。", "info");
  render();
}

async function loadProfiles() {
  const stored = await chrome.storage.local.get({profiles: []});
  state.profiles = Array.isArray(stored.profiles) ? stored.profiles.filter(isProfile) : [];
  if (!currentProfiles().some((profile) => profile.id === state.currentProfileId)) state.currentProfileId = "";
  renderProfiles();
}

async function saveProfiles() {
  await chrome.storage.local.set({profiles: state.profiles});
}

function currentProfiles() {
  return state.pageKey ? state.profiles.filter((profile) => profile.pageKey === state.pageKey) : [];
}

function selectedProfile() {
  return currentProfiles().find((profile) => profile.id === state.currentProfileId) || null;
}

function validSelectionDescriptors() {
  const selection = (state.inspector?.selection || []).filter((item) => item.valid && item.descriptor).map((item) => item.descriptor);
  if (selection.length) return selection;
  return state.inspector?.locked && state.inspector?.current?.descriptor ? [state.inspector.current.descriptor] : [];
}

async function chooseDirectory() {
  await openDirectorySettings("choose");
}

async function reauthorizeDirectory() {
  await openDirectorySettings("reauthorize");
}

async function openDirectorySettings(mode) {
  try {
    await sendMessage({type: "OPEN_DIRECTORY_SETTINGS", mode});
    setMessage("已開啟資料夾設定分頁。", "info");
  } catch (error) {
    setMessage(`無法開啟資料夾設定：${formatError(error)}`);
  }
}

function applyDirectory(directory = {}) {
  state.directory = {
    selected: Boolean(directory.selected),
    name: directory.name || "",
    permission: directory.permission || "none"
  };
}

async function writeToDirectory(filename, blob) {
  const response = await sendMessage({type: "WRITE_DIRECTORY", filename, mimeType: blob.type, bufferBase64: await blobToBase64(blob)});
  if (!response?.ok) throw new Error(response?.error || "資料夾儲存失敗。");
  return response.filename;
}

async function downloadFromBrowser(filename, blob) {
  const response = await sendMessage({type: "DOWNLOAD_IMAGE", filename, mimeType: blob.type, bufferBase64: await blobToBase64(blob)});
  if (!response?.ok) throw new Error(response?.error || "瀏覽器下載失敗。");
  return response.downloadId;
}

async function copyPng(blob) {
  if (!navigator.clipboard?.write || !globalThis.ClipboardItem) throw new Error("Clipboard API unavailable; 請點擊複製按鈕重試。");
  await navigator.clipboard.write([new ClipboardItem({"image/png": blob})]);
}

function encodeWebp(pngBlob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(pngBlob);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d").drawImage(image, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => blob?.type === "image/webp" ? resolve(blob) : reject(new Error("瀏覽器未產生 WebP。")), "image/webp", .95);
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("PNG 解碼失敗。")); };
    image.src = url;
  });
}

function sendInspectCommand(command, payload = {}) {
  if (!state.controller.sessionId) return Promise.reject(new Error("尚未綁定工作階段。"));
  return sendMessage({type: "INSPECT_COMMAND", command, sessionId: state.controller.sessionId, ...payload}).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "Inspector command failed.");
    return response;
  });
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    connectControl();
    const requestId = createId();
    pendingCommands.set(requestId, {resolve, reject});
    try {
      controlPort.postMessage({...message, requestId});
    } catch (error) {
      pendingCommands.delete(requestId);
      reject(error);
    }
  });
}

function setMessage(text, kind = "error") {
  elements.message.textContent = text;
  elements.message.dataset.kind = kind;
}

function cancelPendingCapture(text, kind = "warning") {
  if (!state.outputBusy && !state.pendingCapture) return;
  state.pendingCapture = null;
  state.outputBusy = false;
  elements.progress.textContent = "準備就緒";
  setMessage(text, kind);
}

function clearMessage() {
  elements.message.textContent = "";
  elements.message.dataset.kind = "";
}

function emptyState(text) {
  const paragraph = document.createElement("p");
  paragraph.className = "empty-state";
  paragraph.textContent = text;
  return paragraph;
}

function selectRadio(name, value) {
  const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
}

function isProfile(profile) {
  return profile && typeof profile.id === "string" && typeof profile.name === "string" && typeof profile.pageKey === "string" && Array.isArray(profile.targets);
}

function createId() {
  return globalThis.crypto?.randomUUID?.() || `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolutionLabel(status) {
  return {missing: "缺失", ambiguous: "多重命中", needs_confirmation: "待確認"}[status] || "待處理";
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], {type: mimeType});
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  return btoa(binary);
}

async function getStartShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    return commands.find((command) => command.name === "start-inspect")?.shortcut?.trim() || "";
  } catch {
    return "";
  }
}

function openShortcutSettings() {
  const isEdge = navigator.userAgentData?.brands?.some(({brand}) => brand === "Microsoft Edge") || /Edg\//.test(navigator.userAgent);
  chrome.tabs.create({url: `${isEdge ? "edge" : "chrome"}://extensions/shortcuts`}, () => {
    const error = chrome.runtime.lastError;
    if (error) setMessage(`無法開啟快捷鍵設定：${error.message}`);
  });
}

function reportPanelFocus(keyboard) {
  postPanelMessage({type: "DIVSNAP_PANEL_FOCUS", keyboard});
}

function postPanelMessage(message) {
  if (window.parent !== window) window.parent.postMessage(message, "*");
}

async function initPanelLayout() {
  const sections = [...document.querySelectorAll("details.section-card")];
  const stored = await chrome.storage.local.get({panelSections: {}});
  for (const section of sections) section.open = stored.panelSections?.[section.id] === true;
  for (const section of sections) {
    section.addEventListener("toggle", () => {
      chrome.storage.local.set({panelSections: Object.fromEntries(sections.map((item) => [item.id, item.open]))}).catch((error) => setMessage(formatError(error)));
    });
  }
  const shell = document.querySelector(".control-shell");
  let lastHeight = 0;
  const measureHeight = () => {
    let bottom = 0;
    for (const child of shell.children) {
      if (!(child instanceof HTMLElement) || child.hidden) continue;
      if (getComputedStyle(child).display === "none") continue;
      bottom = Math.max(bottom, child.offsetTop + child.offsetHeight);
    }
    return Math.ceil(bottom + (parseFloat(getComputedStyle(shell).paddingBottom) || 0));
  };
  const reportHeight = () => {
    if (document.body.dataset.panelCollapsed === "true") return;
    const height = measureHeight();
    if (height === lastHeight || height < 80) return;
    lastHeight = height;
    postPanelMessage({type: "DIVSNAP_PANEL_HEIGHT", height});
  };
  new ResizeObserver(reportHeight).observe(shell);
  for (const section of sections) section.addEventListener("toggle", () => requestAnimationFrame(reportHeight));
  reportHeight();
  const handle = document.querySelector("#panel-drag");
  let pointerId = null;
  let start = null;
  let dragging = false;
  const end = (event) => {
    if (pointerId === null || (event?.pointerId !== undefined && event.pointerId !== pointerId)) return;
    const releasedId = pointerId;
    pointerId = null;
    try { if (releasedId !== undefined && handle.hasPointerCapture(releasedId)) handle.releasePointerCapture(releasedId); } catch {}
    if (dragging) postPanelMessage({type: "DIVSNAP_PANEL_DRAG_END"});
    else if (event?.type === "pointerup" || event?.type === "mouseup") postPanelMessage({type: "DIVSNAP_PANEL_TOGGLE_COLLAPSE"});
    start = null;
    dragging = false;
  };
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !(event.buttons & 1) || pointerId !== null) return;
    event.preventDefault();
    pointerId = event.pointerId;
    start = {x: event.screenX, y: event.screenY};
    try { handle.setPointerCapture(event.pointerId); } catch {}
  });
  handle.addEventListener("pointermove", (event) => {
    if (event.pointerId !== undefined && event.pointerId !== pointerId) return;
    if (!(event.buttons & 1)) return end(event);
    if (!dragging && Math.hypot(event.screenX - start.x, event.screenY - start.y) < 5) return;
    if (!dragging) {
      dragging = true;
      postPanelMessage({type: "DIVSNAP_PANEL_DRAG_START", x: start.x, y: start.y});
    }
    postPanelMessage({type: "DIVSNAP_PANEL_DRAG_MOVE", x: event.screenX, y: event.screenY, buttons: event.buttons});
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture", "mouseup"]) {
    handle.addEventListener(type, end);
    window.addEventListener(type, end, true);
  }
  window.addEventListener("blur", end);
  document.addEventListener("visibilitychange", () => { if (document.hidden) end(); });
}

async function refreshShortcut() {
  state.shortcut = await getStartShortcut();
  renderShortcut(state.shortcut);
}

function formatError(error) {
  return error?.message || String(error);
}
