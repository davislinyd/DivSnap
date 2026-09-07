const query = new URLSearchParams(location.search);
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

init().catch((error) => setMessage(`初始化失敗：${formatError(error)}`));

async function init() {
  state.handle = await readDirectoryHandle();
  render();
  elements.choose.addEventListener("click", chooseDirectory);
  elements.reauthorize.addEventListener("click", reauthorizeDirectory);
  if (query.get("mode") === "reauthorize" && state.handle) elements.reauthorize.focus();
}

async function chooseDirectory() {
  if (!window.showDirectoryPicker) return setMessage("目前瀏覽器不支援選擇資料夾。");
  try {
    const handle = await window.showDirectoryPicker({mode: "readwrite"});
    await saveDirectoryHandle(handle);
    state.handle = handle;
    await complete(handle, "granted");
  } catch (error) {
    if (error?.name !== "AbortError") setMessage(`選擇資料夾失敗：${formatError(error)}`);
    else setMessage("已取消選擇，原設定保留。", "muted");
  }
}

async function reauthorizeDirectory() {
  if (!state.handle?.requestPermission) return setMessage("目前沒有可重新授權的資料夾，請先選擇資料夾。");
  try {
    const permission = await state.handle.requestPermission({mode: "readwrite"});
    await saveDirectoryHandle(state.handle);
    await complete(state.handle, permission);
  } catch (error) {
    setMessage(`重新授權失敗：${formatError(error)}`);
  }
}

async function complete(handle, permission) {
  render(handle, permission);
  await sendMessage({
    type: "DIRECTORY_UPDATED",
    targetTabId: state.targetTabId,
    sessionId: state.sessionId,
    documentToken: state.documentToken,
    name: handle.name || "已選資料夾",
    permission
  });
  setMessage(permission === "granted" ? "已更新，正在返回原網頁。" : "設定已保留，但仍需要重新授權。", permission === "granted" ? "muted" : "error");
}

function render(handle = state.handle, permission = null) {
  elements.name.textContent = handle?.name || "尚未選擇資料夾";
  elements.status.textContent = handle ? `File System Access · ${permission || queryPermissionLabel(handle)}` : "尚未取得資料夾權限";
  elements.reauthorize.disabled = !handle;
}

function queryPermissionLabel(handle) {
  return handle ? "已記住設定，按重新授權確認寫入權限" : "尚未取得資料夾權限";
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
      else if (response?.ok === false) reject(new Error(response.error || "設定更新失敗。"));
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
