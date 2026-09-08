const query = new URLSearchParams(location.search);
const t = (...args) => DivSnapI18n.t(...args);
const state = {
  targetTabId: Number(query.get("targetTabId")),
  sessionId: query.get("sessionId") || "",
  documentToken: query.get("documentToken") || "",
  handle: null
};

const elements = {
  name: document.querySelector("#directory-name"),
  status: document.querySelector("#directory-status"),
  choose: document.querySelector("#choose"),
  reauthorize: document.querySelector("#reauthorize"),
  message: document.querySelector("#message")
};

init().catch((error) => setMessage(t("initializing", {error: formatError(error)})));

async function init() {
  await DivSnapI18n.load();
  document.title = t("settingsTitle");
  DivSnapI18n.onChange.add(() => { document.title = t("settingsTitle"); render(); });
  state.handle = await readDirectoryHandle();
  render();
  elements.choose.addEventListener("click", chooseDirectory);
  elements.reauthorize.addEventListener("click", reauthorizeDirectory);
  if (query.get("mode") === "reauthorize" && state.handle) elements.reauthorize.focus();
}

async function chooseDirectory() {
  if (!window.showDirectoryPicker) return setMessage(t("folderUnsupported"));
  try {
    const handle = await window.showDirectoryPicker({mode: "readwrite"});
    await saveDirectoryHandle(handle);
    state.handle = handle;
    await complete(handle, "granted");
  } catch (error) {
    if (error?.name !== "AbortError") setMessage(t("chooseFolderFailed", {error: formatError(error)}));
    else setMessage(t("chooseCancelled"), "muted");
  }
}

async function reauthorizeDirectory() {
  if (!state.handle?.requestPermission) return setMessage(t("noFolderToAuthorize"));
  try {
    const permission = await state.handle.requestPermission({mode: "readwrite"});
    await saveDirectoryHandle(state.handle);
    await complete(state.handle, permission);
  } catch (error) {
    setMessage(t("reauthorizeFailed", {error: formatError(error)}));
  }
}

async function complete(handle, permission) {
  render(handle, permission);
  await sendMessage({
    type: "DIRECTORY_UPDATED",
    targetTabId: state.targetTabId,
    sessionId: state.sessionId,
    documentToken: state.documentToken,
    name: handle.name || t("directoryNone"),
    permission
  });
  setMessage(t(permission === "granted" ? "returning" : "retainedNeedsAuthorization"), permission === "granted" ? "muted" : "error");
}

function render(handle = state.handle, permission = null) {
  elements.name.textContent = handle?.name || t("directoryNone");
  elements.status.textContent = handle ? `File System Access · ${permission || queryPermissionLabel(handle)}` : t("directoryPermissionNone");
  elements.reauthorize.disabled = !handle;
}

function queryPermissionLabel(handle) {
  return handle ? t("directoryRemembered") : t("directoryPermissionNone");
}

function setMessage(text, kind = "error") {
  elements.message.textContent = text;
  elements.message.dataset.kind = kind;
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (response?.ok === false) reject(new Error(response.error || t("settingsUpdateFailed")));
      else resolve(response);
    });
  });
}

function openDirectoryDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("divsnap-directory", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("handles")) request.result.createObjectStore("handles");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveDirectoryHandle(handle) {
  const database = await openDirectoryDb();
  await new Promise((resolve, reject) => {
    const request = database.transaction("handles", "readwrite").objectStore("handles").put(handle, "directory");
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
  database.close();
}

async function readDirectoryHandle() {
  const database = await openDirectoryDb();
  const handle = await new Promise((resolve, reject) => {
    const request = database.transaction("handles", "readonly").objectStore("handles").get("directory");
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return handle;
}

function formatError(error) {
  return error?.message || String(error);
}
