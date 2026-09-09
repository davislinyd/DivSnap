(() => {
  if (globalThis.__divsnapInspector) return;

  const COLLAPSED_PANEL_WIDTH = 182;
  const COLLAPSED_PANEL_HEIGHT = 38;
  const MAX_SELECTION_HISTORY = 10;
  const DOUBLE_D_DELAY = 500;

  const state = {
    host: null,
    shadow: null,
    panelHost: null,
    panelShadow: null,
    panelFrame: null,
    panelResize: null,
    panelCollapsedBar: null,
    panelTabId: null,
    panelBounds: null,
    panelCollapsed: false,
    panelDragging: false,
    panelResizing: false,
    panelListeners: [],
    panelGestureListeners: [],
    panelDragStart: null,
    lastEscapeAt: 0,
    lastDAt: 0,
    highlight: null,
    label: null,
    boxLayers: [],
    current: null,
    multiSelection: [],
    locked: false,
    point: null,
    pointDirty: false,
    candidates: [],
    branch: [],
    history: [],
    redoHistory: [],
    frame: null,
    rectCache: new WeakMap(),
    selectionBoxes: new Map(),
    unionBox: null,
    mutationObserver: null,
    resizeObserver: null,
    observedRoots: new Set(),
    observedElements: new Set(),
    listeners: [],
    running: false,
    paused: false,
    busy: false,
    cancelled: false,
    sessionId: null,
    documentToken: createDocumentToken(),
    captureSettings: {captureMode: "visible"},
    captureSnapshot: null,
    captureId: null,
    captureRequested: false,
    profileResolution: [],
    elementDescriptors: new WeakMap()
  };

  globalThis.__divsnapInspector = {start};

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "OPEN_PANEL") {
      openPanel(message)
        .then(() => sendResponse({ok: true, documentToken: state.documentToken}))
        .catch((error) => sendResponse({ok: false, error: error.message || String(error)}));
      return true;
    }
    if (message?.type === "CLOSE_PANEL") {
      if (acceptsIdentity(message)) {
        state.cancelled = true;
        if (state.captureSnapshot) restoreScrollPositions(state.captureSnapshot);
        if (state.running) removeInspector();
        removePanel();
      }
      sendResponse({ok: true});
      return false;
    }
    if (message?.type === "FOCUS_PANEL") {
      if (acceptsIdentity(message)) focusPanel();
      sendResponse({ok: true});
      return false;
    }
    if (message?.type !== "INSPECT_COMMAND") return false;
    handleCommand(message)
      .then(() => sendResponse({ok: true}))
      .catch((error) => sendResponse({ok: false, error: error.message || String(error)}));
    return true;
  });

  async function start() {
    if (state.running) {
      state.paused = false;
      state.cancelled = false;
      state.host.style.display = "block";
      updatePanelOpacity();
      refreshInspector();
      setPanelCollapsed(false);
      return;
    }
    state.running = true;
    state.paused = false;
    state.cancelled = false;
    state.busy = false;
    await createOverlay();
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "auxclick", "contextmenu", "dragstart", "selectstart"]) {
      addListener(window, type, onMouseDown, true);
    }
    addListener(window, "pointermove", onMouseMove, true);
    addListener(window, "mousemove", onMouseMove, true);
    addListener(window, "click", onClick, true);
    addListener(window, "keydown", onKeyDown, true);
    addListener(window, "scroll", onLayoutChange, true);
    addListener(window, "resize", onLayoutChange, true);
    addListener(window, "transitionend", onLayoutChange, true);
    addListener(window, "animationend", onLayoutChange, true);
    state.mutationObserver = new MutationObserver((records) => {
      if (records.some((record) => !isOverlayNode(record.target))) onLayoutChange();
    });
    state.resizeObserver = new ResizeObserver(onLayoutChange);
    observeRoot(document);
    state.point = {x: innerWidth / 2, y: innerHeight / 2};
    onLayoutChange();
    updatePanelOpacity();
    setPanelCollapsed(false);
  }

  async function handleCommand(message) {
    if (!acceptsIdentity(message)) throw new Error("頁面工作階段已更新 / Page session changed.");
    if (message.command === "START") {
      state.captureSettings = {...state.captureSettings, ...message.settings};
      await start();
    } else if (message.command === "PAUSE") {
      state.paused = true;
      state.host && (state.host.style.display = "block");
      updatePanelOpacity();
      sendInspectorState();
    } else if (message.command === "STOP") {
      state.cancelled = true;
      if (state.captureSnapshot) restoreScrollPositions(state.captureSnapshot);
      removeInspector(false);
    } else if (message.command === "GET_STATE") {
      sendInspectorState();
    } else if (message.command === "CAPTURE") {
      state.captureSettings = {...state.captureSettings, ...message.settings};
      captureSelection(state.captureSettings, message.captureId);
    } else if (message.command === "NAVIGATE") {
      navigate(message.key);
    } else if (message.command === "SELECT_CANDIDATE") {
      const target = state.candidates[message.index];
      if (isValidTarget(target)) chooseTarget(target);
    } else if (message.command === "UNLOCK") {
      unlockPreview();
    } else if (message.command === "TOGGLE") {
      toggleCurrent();
    } else if (message.command === "UNDO") {
      undoSelection();
    } else if (message.command === "REDO") {
      redoSelection();
    } else if (message.command === "CLEAR") {
      commitSelection([]);
    } else if (message.command === "REMOVE_SELECTION") {
      removeSelection(message.index);
    } else if (message.command === "LOAD_PROFILE") {
      loadProfile(message.targets || []);
    } else if (message.command === "DISMISS_PROFILE_TARGET") {
      dismissProfileTarget(message.index);
    } else if (message.command === "CLEAR_PROFILE") {
      state.profileResolution = [];
      sendInspectorState();
    }
  }

  async function createOverlay() {
    if (state.host?.isConnected && state.highlight) return;
    if (state.host?.isConnected) {
      state.host.remove();
      state.host = null;
      state.shadow = null;
    }
    const host = document.createElement("div");
    host.setAttribute("data-divsnap-overlay", "true");
    host.style.position = "fixed";
    host.style.inset = "0";
    host.style.zIndex = "2147483646";
    host.style.display = "block";
    host.style.pointerEvents = "none";
    const shadow = host.attachShadow({mode: "open"});
    const style = document.createElement("style");
    try {
      style.textContent = await fetch(chrome.runtime.getURL("overlay.css")).then((response) => response.text());
    } catch {
      style.textContent = "";
    }
    const root = document.createElement("div");
    root.className = "divsnap-root";
    const highlight = document.createElement("div");
    highlight.className = "divsnap-highlight";
    const label = document.createElement("div");
    label.className = "divsnap-label";
    highlight.append(label);
    root.append(highlight);
    shadow.append(style, root);
    (document.documentElement || document.body).append(host);
    state.host = host;
    state.shadow = shadow;
    state.highlight = highlight;
    state.label = label;
    state.unionBox = document.createElement("div");
    state.unionBox.className = "divsnap-union";
    root.append(state.unionBox);
  }

  async function openPanel(message) {
    if (state.sessionId && message.sessionId && state.sessionId !== message.sessionId && state.running) removeInspector();
    state.sessionId = message.sessionId || state.sessionId;
    state.panelTabId = message.tabId ?? state.panelTabId;
    await createPanel();
    const panelUrl = buildPanelUrl();
    if (state.panelFrame.src !== panelUrl) state.panelFrame.src = panelUrl;
    clampPanelToViewport();
    updatePanelOpacity();
  }

  async function createPanel() {
    if (state.panelHost?.isConnected && state.panelFrame) return;
    await globalThis.DivSnapI18n.load();
    const host = document.createElement("div");
    host.setAttribute("data-divsnap-panel", "true");
    host.style.position = "fixed";
    host.style.zIndex = "2147483647";
    host.style.pointerEvents = "auto";
    host.style.display = "block";
    const shadow = host.attachShadow({mode: "open"});
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .panel { position: relative; display: flex; width: 100%; height: 100%; overflow: hidden; flex-direction: column; color: #10263f; background: #f7fafc; border: 1px solid #9eb8ca; border-radius: 10px; box-shadow: 0 12px 34px rgba(9, 36, 65, .28); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .panel { box-sizing: border-box; }
      iframe { display: block; width: 100%; height: 100%; min-height: 0; flex: 1 1 auto; border: 0; background: #f7fafc; }
      .collapsed { box-sizing: border-box; display: flex; width: 100%; height: 100%; align-items: center; gap: 8px; padding: 0 7px 0 8px; color: #10263f; background: #f7fafc; cursor: grab; font: 700 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; touch-action: none; user-select: none; }
      .collapsed:active { cursor: grabbing; }
      .collapsed strong { display: flex; align-items: center; gap: 8px; }
      .collapsed img { width: 22px; height: 22px; border-radius: 6px; }
      .collapsed-action { margin-left: auto; padding: 0; color: #0d759e; background: transparent; border: 0; cursor: pointer; font: 700 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .collapsed-action:hover { color: #073f5c; }
      [hidden] { display: none !important; }
      .resize { position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize; touch-action: none; }
      .resize::after { position: absolute; right: 4px; bottom: 4px; width: 8px; height: 8px; border-right: 2px solid #6f8297; border-bottom: 2px solid #6f8297; content: ""; }
    `;
    const panel = document.createElement("section");
    panel.className = "panel";
    panel.setAttribute("aria-label", DivSnapI18n.t("panel"));
    const frame = document.createElement("iframe");
    frame.title = DivSnapI18n.t("panelTitle");
    frame.setAttribute("allow", "clipboard-write");
    const collapsedBar = document.createElement("div");
    collapsedBar.className = "collapsed";
    collapsedBar.setAttribute("aria-label", DivSnapI18n.t("dragPanel"));
    collapsedBar.hidden = true;
    const collapsedTitle = document.createElement("strong");
    const collapsedIcon = document.createElement("img");
    collapsedIcon.src = chrome.runtime.getURL("icons/icon-32.png");
    collapsedIcon.alt = "";
    collapsedTitle.textContent = "DivSnap";
    collapsedTitle.prepend(collapsedIcon);
    const collapsedAction = document.createElement("button");
    collapsedAction.className = "collapsed-action";
    collapsedAction.type = "button";
    collapsedAction.setAttribute("aria-label", DivSnapI18n.t("expandPanel"));
    collapsedAction.textContent = DivSnapI18n.t("expand");
    collapsedBar.append(collapsedTitle, collapsedAction);
    const resize = document.createElement("div");
    resize.className = "resize";
    resize.setAttribute("role", "button");
    resize.setAttribute("aria-label", DivSnapI18n.t("resizePanel"));
    panel.append(collapsedBar, frame, resize);
    shadow.append(style, panel);
    (document.documentElement || document.body).append(host);
    state.panelHost = host;
    state.panelShadow = shadow;
    state.panelFrame = frame;
    state.panelResize = resize;
    state.panelCollapsedBar = collapsedBar;
    DivSnapI18n.onChange.add(() => updatePanelLabels());
    state.panelBounds = null;
    addPanelListener(resize, "pointerdown", (event) => beginPanelGesture(event, "resize"));
    addPanelListener(collapsedBar, "pointerdown", (event) => beginPanelGesture(event, "drag"));
    addPanelListener(collapsedAction, "pointerdown", (event) => event.stopPropagation());
    addPanelListener(collapsedAction, "click", (event) => {
      event.stopPropagation();
      setPanelCollapsed(false);
    });
    addPanelListener(frame, "load", () => postPanelCollapsed(false));
    addPanelListener(window, "message", onPanelMessage);
    addPanelListener(window, "resize", clampPanelToViewport);
    addPanelListener(window, "keydown", (event) => {
      if (event.key !== "Escape" || event.repeat) return;
      if (state.running && state.locked) return;
      stopPageEvent(event);
      handlePanelEscape();
    }, true);
    addPanelListener(window, "pointerup", stopIframeDrag, true);
    addPanelListener(window, "mouseup", stopIframeDrag, true);
    addPanelListener(window, "pointercancel", stopIframeDrag, true);
    await loadPanelBounds();
    updatePanelOpacity();
  }

  function addPanelListener(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    state.panelListeners.push(() => target.removeEventListener(type, listener, options));
  }

  function buildPanelUrl() {
    const url = new URL(chrome.runtime.getURL("popup/popup.html"));
    url.searchParams.set("tabId", String(state.panelTabId));
    url.searchParams.set("sessionId", String(state.sessionId));
    url.searchParams.set("documentToken", state.documentToken);
    return url.href;
  }

  async function loadPanelBounds() {
    const stored = await chrome.storage.local.get({panelBounds: null}).catch(() => ({panelBounds: null}));
    state.panelBounds = clampPanelBounds(stored.panelBounds || {right: 16, top: 16, width: 320, height: 680});
    applyPanelBounds();
  }

  function clampPanelToViewport() {
    if (!state.panelHost) return;
    const bounds = state.panelBounds || {right: 16, top: 16, width: 320, height: 680};
    state.panelBounds = state.panelCollapsed
      ? clampPanelPosition(bounds, Math.min(COLLAPSED_PANEL_WIDTH, innerWidth), Math.min(COLLAPSED_PANEL_HEIGHT, innerHeight))
      : clampPanelBounds(bounds);
    applyPanelBounds();
  }

  function clampPanelBounds(bounds) {
    const minWidth = Math.min(320, innerWidth);
    const minHeight = Math.min(180, innerHeight);
    const width = clamp(Number.isFinite(bounds?.width) ? bounds.width : 420, minWidth, Math.min(900, innerWidth));
    const height = clamp(Number.isFinite(bounds?.height) ? bounds.height : 420, minHeight, Math.min(1200, innerHeight));
    return clampPanelPosition({...bounds, width, height}, width, height);
  }

  function clampPanelPosition(bounds, renderedWidth, renderedHeight) {
    const left = clamp(Number.isFinite(bounds?.left) ? bounds.left : innerWidth - renderedWidth - 16, 0, Math.max(0, innerWidth - renderedWidth));
    const top = clamp(Number.isFinite(bounds?.top) ? bounds.top : 16, 0, Math.max(0, innerHeight - renderedHeight));
    return {left: Math.round(left), top: Math.round(top), width: Math.round(bounds.width), height: Math.round(bounds.height)};
  }

  function applyPanelBounds() {
    if (!state.panelHost || !state.panelBounds) return;
    if (state.panelFrame) state.panelFrame.hidden = state.panelCollapsed;
    if (state.panelResize) state.panelResize.hidden = state.panelCollapsed;
    if (state.panelCollapsedBar) state.panelCollapsedBar.hidden = !state.panelCollapsed;
    if (!state.panelCollapsed) {
      for (const [key, value] of Object.entries(state.panelBounds)) state.panelHost.style[key] = `${value}px`;
      return;
    }
    const width = Math.min(COLLAPSED_PANEL_WIDTH, innerWidth);
    const height = Math.min(COLLAPSED_PANEL_HEIGHT, innerHeight);
    state.panelHost.style.left = `${clamp(state.panelBounds.left, 0, Math.max(0, innerWidth - width))}px`;
    state.panelHost.style.top = `${clamp(state.panelBounds.top, 0, Math.max(0, innerHeight - height))}px`;
    state.panelHost.style.width = `${width}px`;
    state.panelHost.style.height = `${height}px`;
  }

  function updatePanelLabels() {
    if (!state.panelShadow) return;
    state.panelShadow.querySelector(".panel")?.setAttribute("aria-label", DivSnapI18n.t("panel"));
    if (state.panelFrame) state.panelFrame.title = DivSnapI18n.t("panelTitle");
    if (state.panelCollapsedBar) state.panelCollapsedBar.setAttribute("aria-label", DivSnapI18n.t("dragPanel"));
    const action = state.panelShadow.querySelector(".collapsed-action");
    if (action) { action.setAttribute("aria-label", DivSnapI18n.t("expandPanel")); action.textContent = DivSnapI18n.t("expand"); }
    state.panelResize?.setAttribute("aria-label", DivSnapI18n.t("resizePanel"));
  }

  function setPanelCollapsed(collapsed) {
    if (!state.panelHost || state.panelCollapsed === collapsed) return;
    state.panelCollapsed = collapsed;
    state.panelBounds = collapsed
      ? clampPanelPosition(state.panelBounds, Math.min(COLLAPSED_PANEL_WIDTH, innerWidth), Math.min(COLLAPSED_PANEL_HEIGHT, innerHeight))
      : clampPanelBounds(state.panelBounds);
    applyPanelBounds();
    if (!collapsed) persistPanelBounds();
  }

  function postPanelCollapsed(collapsed = false) {
    state.panelFrame?.contentWindow?.postMessage({type: "DIVSNAP_PANEL_COLLAPSED", collapsed}, new URL(chrome.runtime.getURL("/")).origin);
  }

  function persistPanelBounds() {
    if (!state.panelBounds) return;
    chrome.storage.local.set({panelBounds: state.panelBounds}).catch(() => {});
  }

  function beginPanelGesture(event, type) {
    if (event.button !== 0 || !(event.buttons & 1) || !state.panelBounds) return;
    for (const remove of state.panelGestureListeners.splice(0)) remove();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    try { target.setPointerCapture(pointerId); } catch {}
    event.preventDefault();
    event.stopPropagation();
    state.panelDragging = type === "drag";
    state.panelResizing = type === "resize";
    const start = {x: event.clientX, y: event.clientY, ...state.panelBounds};
    const move = (moveEvent) => {
      if (moveEvent.pointerId !== undefined && moveEvent.pointerId !== pointerId) return;
      if (!((moveEvent.buttons ?? 0) & 1)) return end(moveEvent);
      moveEvent.preventDefault();
      moveEvent.stopImmediatePropagation();
      const deltaX = moveEvent.clientX - start.x;
      const deltaY = moveEvent.clientY - start.y;
      state.panelBounds = type === "drag"
        ? (state.panelCollapsed
          ? clampPanelPosition({...start, left: start.left + deltaX, top: start.top + deltaY}, Math.min(COLLAPSED_PANEL_WIDTH, innerWidth), Math.min(COLLAPSED_PANEL_HEIGHT, innerHeight))
          : clampPanelBounds({left: start.left + deltaX, top: start.top + deltaY, width: start.width, height: start.height}))
        : clampPanelBounds({left: start.left, top: start.top, width: start.width + deltaX, height: start.height + deltaY});
      applyPanelBounds();
    };
    const end = (endEvent) => {
      if (endEvent?.pointerId !== undefined && endEvent.pointerId !== pointerId) return;
      for (const remove of state.panelGestureListeners.splice(0)) remove();
      try { if (pointerId !== undefined && target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId); } catch {}
      state.panelDragging = false;
      state.panelResizing = false;
      persistPanelBounds();
      updatePanelOpacity();
    };
    for (const [surface, name, listener] of [[window, "pointermove", move], [window, "pointerup", end], [window, "pointercancel", end], [target, "lostpointercapture", end], [window, "blur", end]]) {
      surface.addEventListener(name, listener, true);
      state.panelGestureListeners.push(() => surface.removeEventListener(name, listener, true));
    }
    window.addEventListener("mouseup", end, true);
    state.panelGestureListeners.push(() => window.removeEventListener("mouseup", end, true));
    updatePanelOpacity();
  }

  function onPanelMessage(event) {
    if (event.source !== state.panelFrame?.contentWindow || event.origin !== new URL(chrome.runtime.getURL("/")).origin) return;
    const message = event.data;
    if (message?.type === "DIVSNAP_PANEL_CLOSE") return closePanelByUser();
    if (message?.type === "DIVSNAP_PANEL_TOGGLE_COLLAPSE") return setPanelCollapsed(!state.panelCollapsed);
    if (message?.type === "DIVSNAP_PANEL_FOCUS") return focusPanel();
    if (message?.type === "DIVSNAP_PANEL_ESCAPE") return handlePanelEscape();
    if (message?.type === "DIVSNAP_PANEL_ENTER") return handleInspectorEnter();
    if (message?.type === "DIVSNAP_PANEL_KEYDOWN") return handleSelectionKey(message);
    if (message?.type === "DIVSNAP_PANEL_HEIGHT" && Number.isFinite(message.height) && state.panelBounds && !state.panelResizing) {
      state.panelBounds = clampPanelBounds({...state.panelBounds, height: message.height + 2});
      applyPanelBounds();
      persistPanelBounds();
    } else if (message?.type === "DIVSNAP_PANEL_DRAG_START" && state.panelBounds && Number.isFinite(message.x) && Number.isFinite(message.y)) {
      state.panelDragStart = {...state.panelBounds, x: message.x, y: message.y};
      state.panelDragging = true;
    } else if (message?.type === "DIVSNAP_PANEL_DRAG_MOVE" && state.panelDragStart && Number.isFinite(message.x) && Number.isFinite(message.y)) {
      if (message.buttons === 0) stopIframeDrag();
      else {
        const start = state.panelDragStart;
        state.panelBounds = clampPanelBounds({...start, left: start.left + message.x - start.x, top: start.top + message.y - start.y});
        applyPanelBounds();
      }
    } else if (message?.type === "DIVSNAP_PANEL_DRAG_END") {
      stopIframeDrag();
    }
    updatePanelOpacity();
  }

  function stopIframeDrag() {
    if (!state.panelDragging && !state.panelDragStart) return;
    state.panelDragStart = null;
    state.panelDragging = false;
    persistPanelBounds();
    updatePanelOpacity();
  }

  function handlePanelEscape() {
    if (state.running && state.locked) {
      state.lastEscapeAt = 0;
      unlockPreview();
      return;
    }
    const now = Date.now();
    if (state.lastEscapeAt && now - state.lastEscapeAt <= 500) return closePanelByUser();
    state.lastEscapeAt = now;
    if (state.captureSnapshot) restoreScrollPositions(state.captureSnapshot);
    if (state.running) removeInspector();
  }

  function focusPanel() {
    state.panelFrame?.focus({preventScroll: true});
    updatePanelOpacity();
  }

  function updatePanelOpacity() {
    if (!state.panelHost) return;
    state.panelHost.style.opacity = "1";
    state.panelHost.style.transition = "";
  }

  function closePanelByUser() {
    state.cancelled = true;
    if (state.captureSnapshot) restoreScrollPositions(state.captureSnapshot);
    if (state.running) removeInspector();
    removePanel();
    chrome.runtime.sendMessage({type: "PANEL_CLOSED", sessionId: state.sessionId, documentToken: state.documentToken}).catch?.(() => {});
  }

  function removePanel() {
    for (const remove of state.panelGestureListeners.splice(0)) remove();
    for (const remove of state.panelListeners.splice(0)) remove();
    state.panelHost?.remove();
    state.panelHost = null;
    state.panelShadow = null;
    state.panelFrame = null;
    state.panelResize = null;
    state.panelCollapsedBar = null;
    state.panelBounds = null;
    state.panelCollapsed = false;
    state.panelDragging = false;
    state.panelResizing = false;
    state.panelDragStart = null;
    state.lastEscapeAt = 0;
  }

  function acceptsIdentity(message) {
    return message.sessionId === state.sessionId && message.documentToken === state.documentToken;
  }

  function addListener(target, type, listener, capture = false) {
    target.addEventListener(type, listener, capture);
    state.listeners.push(() => target.removeEventListener(type, listener, capture));
  }

  function isOverlayNode(node) {
    return node === state.host || node === state.panelHost || state.host?.contains(node) || state.panelHost?.contains(node) || node?.getRootNode() === state.shadow || node?.getRootNode() === state.panelShadow;
  }

  function isInspectorEvent(event) {
    const path = event.composedPath();
    return path.includes(state.host) || path.includes(state.panelHost);
  }

  function stopPageEvent(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onMouseDown(event) {
    if (state.panelDragging || state.panelResizing) return;
    if (!state.running || state.paused || state.busy || isInspectorEvent(event)) return;
    stopPageEvent(event);
    if (event.button !== 0 || !["pointerdown", "mousedown"].includes(event.type) || state.locked) return;
    if (state.point?.x !== event.clientX || state.point?.y !== event.clientY) {
      state.point = {x: event.clientX, y: event.clientY};
      state.pointDirty = true;
    }
    if (state.pointDirty) refreshInspector();
  }

  function onMouseMove(event) {
    if (state.panelDragging || state.panelResizing) return;
    if (!state.running || state.paused || state.busy || isInspectorEvent(event)) return;
    stopPageEvent(event);
    state.point = {x: event.clientX, y: event.clientY};
    if (!state.locked) {
      state.pointDirty = true;
      scheduleRefresh();
    }
  }

  function onClick(event) {
    if (state.panelDragging || state.panelResizing) return;
    if (!state.running || state.paused || state.busy || isInspectorEvent(event)) return;
    stopPageEvent(event);
    if (event.button !== 0 || !isValidTarget(state.current)) return;
    if (event.shiftKey) toggleCurrent();
    else {
      state.locked = true;
      state.pointDirty = false;
      refreshInspector();
    }
  }

  function onKeyDown(event) {
    if (!state.running || state.paused || state.busy) return;
    if (event.key === "Escape") {
      stopPageEvent(event);
      state.lastDAt = 0;
      if (state.locked) return unlockPreview();
      removeInspector(false);
      return;
    }
    if (isInspectorEvent(event)) return;
    if (handleSelectionKey(event)) stopPageEvent(event);
  }

  function handleSelectionKey(event) {
    if (!state.running || state.paused || state.busy) return false;
    const key = String(event.key || "");
    const isPlainD = !event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat && key.toLowerCase() === "d";
    if (isPlainD && (state.multiSelection.length || state.locked)) {
      const now = Date.now();
      if (now - state.lastDAt <= DOUBLE_D_DELAY) {
        state.lastDAt = 0;
        clearSelection();
      } else {
        state.lastDAt = now;
      }
      return true;
    }
    state.lastDAt = 0;
    if (key === "Enter") {
      handleInspectorEnter();
      return true;
    }
    if (event.code === "Space" || key === " ") {
      unlockPreview();
      return true;
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && key.toLowerCase() === "z") {
      redoSelection();
      return true;
    }
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && key.toLowerCase() === "z") {
      undoSelection();
      return true;
    }
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) {
      navigate(key);
      return true;
    }
    return false;
  }

  function handleInspectorEnter() {
    if (!state.running || state.paused || state.busy) return;
    if (state.locked) requestKeyboardCapture();
    else if (state.multiSelection.length || isValidTarget(state.current)) {
      state.locked = true;
      state.pointDirty = false;
      refreshInspector();
    }
  }

  function rectFor(element) {
    if (!state.rectCache.has(element)) state.rectCache.set(element, element.getBoundingClientRect());
    return state.rectCache.get(element);
  }

  function isValidTarget(element) {
    if (!isSelectable(element) || !element.isConnected || element === document.body || element === document.documentElement) return false;
    const rect = rectFor(element);
    if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return false;
    if (element.checkVisibility) return element.checkVisibility({visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true});
    const styles = getComputedStyle(element);
    return styles.visibility === "visible" && styles.display !== "none";
  }

  function ancestorChain(element) {
    const chain = [];
    while (element && element !== document.body && element !== document.documentElement) {
      if (isValidTarget(element)) chain.push(element);
      element = parentElementAcrossShadow(element);
    }
    return chain;
  }

  function candidatesAtPoint(clientX, clientY) {
    const candidates = new Set();
    const visited = new Set();
    function visit(root) {
      if (visited.has(root)) return;
      visited.add(root);
      observeRoot(root);
      for (const element of root.elementsFromPoint(clientX, clientY)) {
        if (isOverlayNode(element)) continue;
        if (element.shadowRoot?.mode === "open") visit(element.shadowRoot);
        for (const candidate of ancestorChain(element)) candidates.add(candidate);
      }
    }
    visit(document);
    return [...candidates];
  }

  function updateFromPoint(x, y) {
    state.candidates = candidatesAtPoint(x, y);
    state.current = state.candidates[0] || null;
    state.branch = state.current ? ancestorChain(state.current) : [];
  }

  function chooseTarget(target) {
    state.rectCache = new WeakMap();
    if (!isValidTarget(target)) return;
    if (!state.branch.includes(target)) {
      const leaf = state.candidates.find((candidate) => candidate === target || isAncestorOf(target, candidate)) || target;
      state.branch = ancestorChain(leaf);
    }
    state.current = target;
    state.locked = true;
    refreshInspector();
  }

  function sameBounds(first, second) {
    const firstRect = rectFor(first);
    const secondRect = rectFor(second);
    return ["left", "top", "right", "bottom"].every((edge) => Math.abs(firstRect[edge] - secondRect[edge]) <= 1);
  }

  function navigate(key) {
    state.rectCache = new WeakMap();
    if (!isValidTarget(state.current)) return;
    let next = null;
    if (key === "ArrowUp" || key === "ArrowDown") {
      const direction = key === "ArrowUp" ? 1 : -1;
      const index = state.branch.indexOf(state.current);
      for (let cursor = index + direction; index >= 0 && cursor >= 0 && cursor < state.branch.length; cursor += direction) {
        const candidate = state.branch[cursor];
        if (isValidTarget(candidate) && !sameBounds(state.current, candidate)) {
          next = candidate;
          break;
        }
      }
    } else {
      const property = key === "ArrowLeft" ? "previousElementSibling" : "nextElementSibling";
      next = state.current[property];
      while (next && !isValidTarget(next)) next = next[property];
    }
    if (next) chooseTarget(next);
  }

  function unlockPreview() {
    state.locked = false;
    state.pointDirty = true;
    refreshInspector();
  }

  function commitSelection(next) {
    if (next.length === state.multiSelection.length && next.every((element, index) => element === state.multiSelection[index])) return;
    state.history.push(state.multiSelection.slice());
    if (state.history.length > MAX_SELECTION_HISTORY) state.history.shift();
    state.redoHistory = [];
    state.multiSelection = next;
    for (const element of next) getElementDescriptor(element);
    refreshInspector();
  }

  function toggleCurrent() {
    state.rectCache = new WeakMap();
    const target = state.current;
    if (!isValidTarget(target)) return;
    const next = state.multiSelection.includes(target)
      ? state.multiSelection.filter((element) => element !== target)
      : [...state.multiSelection.filter((element) => !isAncestorOf(element, target) && !isAncestorOf(target, element)), target];
    state.locked = false;
    state.pointDirty = false;
    commitSelection(next);
  }

  function removeSelection(index) {
    if (!Number.isInteger(index) || index < 0 || index >= state.multiSelection.length) return;
    commitSelection(state.multiSelection.filter((element, elementIndex) => elementIndex !== index));
  }

  function undoSelection() {
    if (!state.history.length) {
      if (state.locked) unlockPreview();
      return;
    }
    state.redoHistory.push(state.multiSelection.slice());
    if (state.redoHistory.length > MAX_SELECTION_HISTORY) state.redoHistory.shift();
    state.multiSelection = state.history.pop();
    state.locked = false;
    refreshInspector();
  }

  function redoSelection() {
    if (!state.redoHistory.length) return;
    state.history.push(state.multiSelection.slice());
    if (state.history.length > MAX_SELECTION_HISTORY) state.history.shift();
    state.multiSelection = state.redoHistory.pop();
    state.locked = false;
    refreshInspector();
  }

  function clearSelection() {
    if (state.multiSelection.length) commitSelection([]);
    if (state.locked) unlockPreview();
  }
  function captureSelection(settings = state.captureSettings, captureId = null) {
    if (!state.running || state.busy) return;
    state.captureRequested = false;
    state.rectCache = new WeakMap();
    const elements = state.multiSelection.length ? state.multiSelection.slice() : state.locked && state.current ? [state.current] : [];
    state.captureId = captureId || `capture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (!elements.length || elements.some((element) => !isValidTarget(element)) || state.profileResolution.some((item) => item.status !== "resolved")) {
      refreshInspector();
      sendCaptureResult(false, DivSnapI18n.t("targetInvalid"));
      state.captureId = null;
      return;
    }
    state.busy = true;
    finishSelection(elements, elements.length > 1, settings).catch((error) => {
      state.busy = false;
      if (state.captureSnapshot) restoreScrollPositions(state.captureSnapshot);
      state.captureSnapshot = null;
      if (state.running && !state.cancelled) {
        state.paused = true;
        sendCaptureResult(false, error.message || String(error));
        updatePanelOpacity();
        sendInspectorState(DivSnapI18n.t("captureRuntimeFailed", {error: error.message || String(error)}));
      }
    }).finally(() => { state.captureId = null; });
  }

  function requestKeyboardCapture() {
    if (state.captureRequested) return;
    state.captureRequested = true;
    chrome.runtime.sendMessage({
      type: "CAPTURE_REQUEST",
      sessionId: state.sessionId,
      documentToken: state.documentToken
    }).then((response) => {
      if (!response?.ok) state.captureRequested = false;
    }).catch(() => { state.captureRequested = false; });
  }

  function isAncestorOf(ancestor, element) {
    if (!ancestor || !element || ancestor === element) return false;
    let node = parentElementAcrossShadow(element);
    while (node) {
      if (node === ancestor) return true;
      node = parentElementAcrossShadow(node);
    }
    return false;
  }

  function observeRoot(root) {
    if (!state.mutationObserver || state.observedRoots.has(root)) return;
    state.mutationObserver.observe(root === document ? document.documentElement : root, {childList: true, attributes: true, characterData: true, subtree: true});
    state.observedRoots.add(root);
  }

  function observeTargets() {
    const elements = new Set();
    for (const target of [state.current, ...state.multiSelection]) {
      let element = target;
      while (element?.isConnected && !isOverlayNode(element)) {
        elements.add(element);
        element = parentElementAcrossShadow(element);
      }
    }
    for (const element of state.observedElements) {
      if (!elements.has(element)) state.resizeObserver.unobserve(element);
    }
    for (const element of elements) {
      if (!state.observedElements.has(element)) state.resizeObserver.observe(element);
    }
    state.observedElements = elements;
  }

  function onLayoutChange() {
    state.pointDirty = true;
    clampPanelToViewport();
    scheduleRefresh();
  }

  function scheduleRefresh() {
    if (!state.running || state.busy || state.frame !== null) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = null;
      refreshInspector();
    });
  }

  function placeBox(box, rect) {
    box.style.display = rect ? "block" : "none";
    if (!rect) return;
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  }

  function paintTarget(target) {
    const valid = isValidTarget(target);
    placeBox(state.highlight, valid ? rectFor(target) : null);
    if (!valid) {
      clearBoxLayers();
      return;
    }
    const rect = rectFor(target);
    state.label.textContent = `${state.locked ? DivSnapI18n.t("locked") : ""}${describeElement(target)}`;
    state.label.dataset.below = rect.top < 36 ? "true" : "false";
    if (state.multiSelection.length) clearBoxLayers();
    else paintBoxModel(target, rect);
  }

  function refreshInspector() {
    if (!state.running || !state.highlight) return;
    state.rectCache = new WeakMap();
    if (state.pointDirty && !state.locked && state.point) {
      updateFromPoint(state.point.x, state.point.y);
      state.pointDirty = false;
    }
    if (state.locked && isValidTarget(state.current)) {
      const leaf = state.branch[0];
      state.branch = ancestorChain(leaf && (leaf === state.current || isAncestorOf(state.current, leaf)) ? leaf : state.current);
      state.candidates = [...new Set([...state.branch, ...state.candidates])];
    }
    paintTarget(state.current);
    const valid = state.multiSelection.filter(isValidTarget);
    for (const [element, box] of state.selectionBoxes) {
      if (!valid.includes(element)) {
        box.remove();
        state.selectionBoxes.delete(element);
      }
    }
    for (const element of valid) {
      if (!state.selectionBoxes.has(element)) {
        const box = document.createElement("div");
        box.className = "divsnap-selected";
        state.shadow.querySelector(".divsnap-root").append(box);
        state.selectionBoxes.set(element, box);
      }
      placeBox(state.selectionBoxes.get(element), rectFor(element));
    }
    const invalid = valid.length !== state.multiSelection.length;
    placeBox(state.unionBox, !invalid && valid.length ? unionRects(valid.map(rectFor)) : null);
    observeTargets();
    state.candidates = state.candidates.filter(isValidTarget);
    if (isValidTarget(state.current) && !state.candidates.includes(state.current)) state.candidates.push(state.current);
    const message = invalid || (state.locked && !isValidTarget(state.current))
      ? DivSnapI18n.t("targetInvalid")
      : DivSnapI18n.t("selectedStatus", {count: state.multiSelection.length, state: DivSnapI18n.t(state.locked ? "previewLocked" : "hoverPreview")});
    sendInspectorState(message);
  }

  function paintBoxModel(target, rect) {
    clearBoxLayers();
    const styles = getComputedStyle(target);
    const margin = {
      top: parseFloat(styles.marginTop) || 0,
      right: parseFloat(styles.marginRight) || 0,
      bottom: parseFloat(styles.marginBottom) || 0,
      left: parseFloat(styles.marginLeft) || 0
    };
    const border = {
      top: parseFloat(styles.borderTopWidth) || 0,
      right: parseFloat(styles.borderRightWidth) || 0,
      bottom: parseFloat(styles.borderBottomWidth) || 0,
      left: parseFloat(styles.borderLeftWidth) || 0
    };
    const padding = {
      top: parseFloat(styles.paddingTop) || 0,
      right: parseFloat(styles.paddingRight) || 0,
      bottom: parseFloat(styles.paddingBottom) || 0,
      left: parseFloat(styles.paddingLeft) || 0
    };
    addBox("margin", rect.left - margin.left, rect.top - margin.top,
      rect.width + margin.left + margin.right, rect.height + margin.top + margin.bottom, 1);
    addBox("border", rect.left, rect.top, rect.width, rect.height, Math.max(border.top, 1));
    addBox("padding", rect.left + border.left, rect.top + border.top,
      Math.max(0, rect.width - border.left - border.right), Math.max(0, rect.height - border.top - border.bottom), 1);
    addBox("content", rect.left + border.left + padding.left, rect.top + border.top + padding.top,
      Math.max(0, rect.width - border.left - border.right - padding.left - padding.right),
      Math.max(0, rect.height - border.top - border.bottom - padding.top - padding.bottom), 1);
  }

  function addBox(kind, left, top, width, height, borderWidth) {
    const box = document.createElement("div");
    box.className = `divsnap-box divsnap-${kind}`;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
    box.style.borderWidth = `${borderWidth}px`;
    state.shadow.querySelector(".divsnap-root").append(box);
    state.boxLayers.push(box);
  }

  function clearBoxLayers() {
    for (const layer of state.boxLayers) layer.remove();
    state.boxLayers = [];
  }

  async function finishSelection(elements, multi, settings) {
    const dpr = window.devicePixelRatio || 1;
    const ancestors = [...new Set(elements.flatMap((element) => scrollableAncestors(element)))];
    state.captureSnapshot = saveScrollPositionsForAncestors(ancestors);
    let fullLayoutSnapshot = [];
    let result;
    let payload;
    try {
      hideDivsnapUi();
      if (settings.captureMode === "full") fullLayoutSnapshot = prepareFullLayout(elements);
      await waitForPaint();
      assertNotCancelled();
      state.rectCache = new WeakMap();
      if (elements.some((element) => !isValidTarget(element))) throw new Error("Selected elements changed. Please select again.");
      result = settings.captureMode === "full"
        ? multi
          ? await captureFullMulti(elements, dpr)
          : await captureFull(elements[0], dpr)
        : multi
          ? await captureVisibleMulti(elements, dpr)
          : await captureVisible(elements[0], dpr);
      assertNotCancelled();
      const blob = await canvasToBlob(result.canvas);
      const bufferBase64 = await blobToBase64(blob);
      assertNotCancelled();
      state.paused = true;
      payload = {
        bufferBase64,
        mimeType: "image/png",
        filenameBase: multi ? buildMultiFilename() : buildFilename(elements[0]),
        notices: [result.notice, result.clipped ? DivSnapI18n.t("visibleClipped") : ""].filter(Boolean)
      };
    } finally {
      restoreFullLayout(fullLayoutSnapshot);
      if (state.captureSnapshot) restoreScrollPositions(state.captureSnapshot);
      state.captureSnapshot = null;
      state.busy = false;
      if (state.running && !state.cancelled) {
        state.paused = true;
        showDivsnapUi();
        refreshInspector();
        focusPanel();
      }
    }
    sendCaptureResult(true, "", payload);
  }

  function prepareFullLayout(elements) {
    const snapshots = [];
    const seen = new Set();
    const positioned = [];
    try {
      for (const element of elements) {
        const ancestors = [];
        for (let node = element; node && node !== state.host; node = parentElementAcrossShadow(node)) ancestors.push(node);
        for (const target of ancestors.reverse()) {
          if (seen.has(target)) continue;
          seen.add(target);
          const computed = getComputedStyle(target);
          const isPositioned = ["fixed", "sticky"].includes(computed.position);
          const clipped = [computed.overflow, computed.overflowX, computed.overflowY].some((value) => value !== "visible");
          const contained = computed.contain.includes("paint") || computed.contain === "strict" || computed.contain === "content";
          const constrained = isPositioned || clipped || contained || computed.scrollBehavior !== "auto" || computed.scrollSnapType !== "none";
          if (!constrained) continue;
          const rect = target.getBoundingClientRect();
          const style = target.style;
          const properties = ["position", "left", "top", "right", "bottom", "width", "height", "box-sizing", "transform", "overflow", "overflow-x", "overflow-y", "contain", "scroll-behavior", "scroll-snap-type"];
          const saved = properties.map((property) => ({property, value: style.getPropertyValue(property), priority: style.getPropertyPriority(property)}));
          if (isPositioned) {
            style.setProperty("position", "absolute", "important");
            style.setProperty("left", "0", "important");
            style.setProperty("top", "0", "important");
            style.setProperty("right", "auto", "important");
            style.setProperty("bottom", "auto", "important");
            style.setProperty("width", `${rect.width}px`, "important");
            style.setProperty("height", `${rect.height}px`, "important");
            style.setProperty("box-sizing", "border-box", "important");
            style.setProperty("transform", "none", "important");
          }
          if (clipped) {
            style.setProperty("overflow", "visible", "important");
            style.setProperty("overflow-x", "visible", "important");
            style.setProperty("overflow-y", "visible", "important");
          }
          if (contained) style.setProperty("contain", "none", "important");
          if (computed.scrollBehavior !== "auto") style.setProperty("scroll-behavior", "auto", "important");
          if (computed.scrollSnapType !== "none") style.setProperty("scroll-snap-type", "none", "important");
          snapshots.push({element: target, saved});
          if (isPositioned) positioned.push({element: target, left: scrollX + rect.left, top: scrollY + rect.top});
        }
      }
      for (const item of positioned) {
        const rect = item.element.getBoundingClientRect();
        item.element.style.setProperty("left", `${parseFloat(item.element.style.left) + item.left - scrollX - rect.left}px`, "important");
        item.element.style.setProperty("top", `${parseFloat(item.element.style.top) + item.top - scrollY - rect.top}px`, "important");
      }
      return snapshots;
    } catch (error) {
      restoreFullLayout(snapshots);
      throw error;
    }
  }

  function restoreFullLayout(snapshots) {
    for (const {element, saved} of snapshots) {
      for (const {property, value, priority} of saved) {
        if (value) element.style.setProperty(property, value, priority);
        else element.style.removeProperty(property);
      }
    }
  }

  function hideDivsnapUi() {
    if (state.host) state.host.style.visibility = "hidden";
    if (state.panelHost) {
      state.panelHost.style.visibility = "hidden";
      state.panelHost.style.pointerEvents = "none";
    }
  }

  function showDivsnapUi() {
    if (state.host) state.host.style.visibility = "visible";
    if (state.panelHost) {
      state.panelHost.style.visibility = "visible";
      state.panelHost.style.pointerEvents = "auto";
    }
    updatePanelOpacity();
  }

  function sendCaptureResult(ok, error = "", payload = {}) {
    chrome.runtime.sendMessage({
      type: "CAPTURE_RESULT",
      sessionId: state.sessionId,
      documentToken: state.documentToken,
      captureId: state.captureId,
      ok,
      error,
      ...payload
    }).catch?.(() => {});
  }

  async function captureVisible(target, dpr) {
    target.scrollIntoView({block: "nearest", inline: "nearest"});
    await waitForPaint();
    return captureVisibleRegion(target.getBoundingClientRect(), dpr);
  }

  async function captureVisibleMulti(elements, dpr) {
    const region = unionViewportRegion(elements);
    if (!region) throw new Error("Selected elements are no longer available.");
    return captureVisibleRegion(region, dpr);
  }

  async function captureVisibleRegion(region, dpr) {
    const left = Math.max(0, region.left);
    const top = Math.max(0, region.top);
    const right = Math.min(innerWidth, region.right);
    const bottom = Math.min(innerHeight, region.bottom);
    if (right <= left || bottom <= top) throw new Error("Element is outside the viewport.");
    const clipped = left !== region.left || top !== region.top || right !== region.right || bottom !== region.bottom;
    const dataUrl = await requestCapture();
    const image = await loadImage(dataUrl);
    const canvas = document.createElement("canvas");
    const sourceScaleX = image.naturalWidth / innerWidth;
    const sourceScaleY = image.naturalHeight / innerHeight;
    canvas.width = Math.max(1, Math.round((right - left) * dpr));
    canvas.height = Math.max(1, Math.round((bottom - top) * dpr));
    const context = canvas.getContext("2d");
    context.drawImage(image,
      Math.round(left * sourceScaleX), Math.round(top * sourceScaleY),
      Math.round((right - left) * sourceScaleX), Math.round((bottom - top) * sourceScaleY),
      0, 0, canvas.width, canvas.height);
    return {canvas, clipped};
  }

  async function captureFullMulti(elements, dpr) {
    const ancestors = sharedScrollableAncestors(elements);
    if (!ancestors) throw new Error("Full capture could not normalize the selected scroll containers.");
    const region = unionLayoutRegion(elements, ancestors);
    if (!region || region.width <= 0 || region.height <= 0) {
      throw new Error("Selected elements have no capture area.");
    }
    if (region.width * dpr > 8192 || region.height * dpr > 8192) {
      const fallback = await captureVisibleMulti(elements, dpr);
      return {...fallback, notice: DivSnapI18n.t("fullTooLarge")};
    }

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(region.width * dpr));
    canvas.height = Math.max(1, Math.round(region.height * dpr));
    const context = canvas.getContext("2d");
    const snapshot = saveScrollPositionsForAncestors(ancestors);
    let y = 0;
    let guard = 0;
    try {
      while (y < region.height - 0.5 && guard++ < 10_000) {
        let x = 0;
        let rowBottom = region.height;
        let rowProgress = false;
        while (x < region.width - 0.5 && guard++ < 10_000) {
          const pointX = x === 0 ? region.left : Math.min(region.right - 1, region.left + x + innerWidth - 1);
          const pointY = y === 0 ? region.top : Math.min(region.bottom - 1, region.top + y + innerHeight - 1);
          await revealLayoutPoint(pointX, pointY, ancestors);
          const visible = visibleLayoutIntersection(region, ancestors);
          const offset = layoutScrollOffset(ancestors);
          const localLeft = clamp(visible.left + scrollX + offset.x - region.left, 0, region.width);
          const localTop = clamp(visible.top + scrollY + offset.y - region.top, 0, region.height);
          const localRight = clamp(visible.right + scrollX + offset.x - region.left, 0, region.width);
          const localBottom = clamp(visible.bottom + scrollY + offset.y - region.top, 0, region.height);
          if (visible.width <= 0 || visible.height <= 0 || localBottom <= y || localRight <= x) {
            throw new Error("Full capture did not make progress.");
          }
          const dataUrl = await requestCapture();
          const image = await loadImage(dataUrl);
          const sourceScaleX = image.naturalWidth / innerWidth;
          const sourceScaleY = image.naturalHeight / innerHeight;
          context.drawImage(image,
            Math.round(visible.left * sourceScaleX), Math.round(visible.top * sourceScaleY),
            Math.round(visible.width * sourceScaleX), Math.round(visible.height * sourceScaleY),
            Math.round(localLeft * dpr), Math.round(localTop * dpr),
            Math.round((localRight - localLeft) * dpr), Math.round((localBottom - localTop) * dpr));
          rowBottom = Math.min(rowBottom, localBottom);
          x = Math.min(region.width, localRight > x + 0.5 ? localRight : x + Math.max(1, visible.width));
          rowProgress = true;
        }
        if (!rowProgress || rowBottom <= y) throw new Error("Full capture did not make vertical progress.");
        y = Math.min(region.height, rowBottom);
      }
      if (y < region.height - 0.5) throw new Error("Full capture was incomplete.");
      return {canvas, clipped: false};
    } finally {
      restoreScrollPositions(snapshot);
    }
  }

  async function captureFull(target, dpr) {
    if (target instanceof SVGElement) return captureFullMulti([target], dpr);
    const width = Math.max(1, target.offsetWidth);
    const height = Math.max(1, target.offsetHeight);
    const snapshot = saveScrollPositions(target);
    if (width * dpr > 8192 || height * dpr > 8192) {
      try {
        const fallback = await captureVisible(target, dpr);
        return {...fallback, notice: DivSnapI18n.t("fullTooLarge")};
      } finally {
        restoreScrollPositions(snapshot);
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    const context = canvas.getContext("2d");
    let y = 0;
    let guard = 0;
    try {
      while (y < height - 0.5 && guard++ < 10_000) {
        let x = 0;
        let rowBottom = height;
        let rowProgress = false;
        while (x < width - 0.5 && guard++ < 10_000) {
          const pointX = x === 0 ? 0 : Math.min(width - 1, x + innerWidth - 1);
          const pointY = y === 0 ? 0 : Math.min(height - 1, y + innerHeight - 1);
          await revealPoint(target, pointX, pointY);
          const rect = target.getBoundingClientRect();
          const visible = intersection(rect, innerWidth, innerHeight);
          if (visible.width <= 0 || visible.height <= 0) {
            throw new Error("Element cannot be brought into view.");
          }
          const localLeft = clamp(visible.left - rect.left, 0, width);
          const localTop = clamp(visible.top - rect.top, 0, height);
          const localRight = clamp(visible.right - rect.left, 0, width);
          const localBottom = clamp(visible.bottom - rect.top, 0, height);
          if (localBottom <= y || localRight <= x) {
            throw new Error("Full capture did not make progress.");
          }
          const dataUrl = await requestCapture();
          const image = await loadImage(dataUrl);
          const sourceScaleX = image.naturalWidth / innerWidth;
          const sourceScaleY = image.naturalHeight / innerHeight;
          context.drawImage(image,
            Math.round(visible.left * sourceScaleX), Math.round(visible.top * sourceScaleY),
            Math.round(visible.width * sourceScaleX), Math.round(visible.height * sourceScaleY),
            Math.round(localLeft * dpr), Math.round(localTop * dpr),
            Math.round((localRight - localLeft) * dpr), Math.round((localBottom - localTop) * dpr));
          rowBottom = Math.min(rowBottom, localBottom);
          const nextX = localRight > x + 0.5 ? localRight : x + Math.max(1, visible.width);
          x = Math.min(width, nextX);
          rowProgress = true;
        }
        if (!rowProgress || rowBottom <= y) throw new Error("Full capture did not make vertical progress.");
        y = Math.min(height, rowBottom);
      }
      if (y < height - 0.5) throw new Error("Full capture was incomplete.");
      return {canvas, clipped: false};
    } finally {
      restoreScrollPositions(snapshot);
    }
  }

  async function revealPoint(target, localX, localY) {
    const ancestors = scrollableAncestors(target);
    for (const ancestor of ancestors) {
      const targetRect = target.getBoundingClientRect();
      const ancestorRect = ancestor.getBoundingClientRect();
      const pointX = targetRect.left + localX;
      const pointY = targetRect.top + localY;
      ancestor.scrollLeft += pointX - ancestorRect.right + 1;
      ancestor.scrollTop += pointY - ancestorRect.bottom + 1;
    }
    const targetRect = target.getBoundingClientRect();
    const pointX = targetRect.left + localX;
    const pointY = targetRect.top + localY;
    window.scrollBy(pointX - innerWidth + 1, pointY - innerHeight + 1);
    await waitForPaint(1);
  }

  function scrollableAncestors(target) {
    const result = [];
    let node = parentElementAcrossShadow(target);
    while (node && node !== document.body && node !== document.documentElement && node !== state.host) {
      if ((node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1) && isScrollable(node)) {
        result.push(node);
      }
      node = parentElementAcrossShadow(node);
    }
    return result;
  }

  function isScrollable(node) {
    const styles = getComputedStyle(node);
    return styles.overflow !== "visible" || styles.overflowX !== "visible" || styles.overflowY !== "visible";
  }

  function saveScrollPositions(target) {
    return saveScrollPositionsForAncestors(scrollableAncestors(target));
  }

  function saveScrollPositionsForAncestors(ancestors) {
    return {
      window: {x: scrollX, y: scrollY},
      ancestors: ancestors.map((node) => ({node, left: node.scrollLeft, top: node.scrollTop}))
    };
  }

  function restoreScrollPositions(snapshot) {
    for (const item of snapshot.ancestors) {
      item.node.scrollLeft = item.left;
      item.node.scrollTop = item.top;
    }
    window.scrollTo(snapshot.window.x, snapshot.window.y);
  }

  function unionViewportRegion(elements) {
    return unionRects(elements.map((element) => element.getBoundingClientRect()));
  }

  function unionLayoutRegion(elements, ancestors) {
    return unionRects(elements.map((element) => {
      const rect = element.getBoundingClientRect();
      const offset = layoutScrollOffset(ancestors);
      return {
        left: rect.left + scrollX + offset.x,
        top: rect.top + scrollY + offset.y,
        right: rect.right + scrollX + offset.x,
        bottom: rect.bottom + scrollY + offset.y
      };
    }));
  }

  function unionRects(rects) {
    const visible = rects.filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
    if (!visible.length) return null;
    const left = Math.min(...visible.map((rect) => rect.left));
    const top = Math.min(...visible.map((rect) => rect.top));
    const right = Math.max(...visible.map((rect) => rect.right));
    const bottom = Math.max(...visible.map((rect) => rect.bottom));
    return {left, top, right, bottom, width: right - left, height: bottom - top};
  }

  function sharedScrollableAncestors(elements) {
    const lists = elements.map((element) => scrollableAncestors(element));
    const first = lists[0] || [];
    return lists.every((list) => list.length === first.length && list.every((node, index) => node === first[index]))
      ? first
      : null;
  }

  function layoutScrollOffset(ancestors) {
    return ancestors.reduce((offset, ancestor) => ({
      x: offset.x + ancestor.scrollLeft,
      y: offset.y + ancestor.scrollTop
    }), {x: 0, y: 0});
  }

  function visibleLayoutIntersection(region, ancestors) {
    const offset = layoutScrollOffset(ancestors);
    let visible = intersection({
      left: region.left - scrollX - offset.x,
      top: region.top - scrollY - offset.y,
      right: region.right - scrollX - offset.x,
      bottom: region.bottom - scrollY - offset.y
    }, innerWidth, innerHeight);
    for (const ancestor of ancestors) visible = clipRegion(visible, ancestor.getBoundingClientRect());
    return visible;
  }

  function clipRegion(region, clip) {
    const left = Math.max(region.left, clip.left);
    const top = Math.max(region.top, clip.top);
    const right = Math.min(region.right, clip.right);
    const bottom = Math.min(region.bottom, clip.bottom);
    return {left, top, right, bottom, width: right - left, height: bottom - top};
  }

  async function revealLayoutPoint(x, y, ancestors) {
    for (const ancestor of ancestors) {
      const point = layoutViewportPoint(x, y, ancestors);
      const rect = ancestor.getBoundingClientRect();
      ancestor.scrollLeft += point.x - rect.right + 1;
      ancestor.scrollTop += point.y - rect.bottom + 1;
    }
    const point = layoutViewportPoint(x, y, ancestors);
    window.scrollBy(point.x - innerWidth + 1, point.y - innerHeight + 1);
    await waitForPaint(1);
  }

  function layoutViewportPoint(x, y, ancestors) {
    const offset = layoutScrollOffset(ancestors);
    return {x: x - scrollX - offset.x, y: y - scrollY - offset.y};
  }

  function intersection(rect, viewportWidth, viewportHeight) {
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(viewportWidth, rect.right);
    const bottom = Math.min(viewportHeight, rect.bottom);
    return {left, top, right, bottom, width: right - left, height: bottom - top};
  }

  function deepElementFromPoint(x, y) {
    let element = document.elementFromPoint(x, y);
    while (element?.shadowRoot?.mode === "open") {
      const shadowRoot = element.shadowRoot;
      const nested = shadowRoot.elementsFromPoint?.(x, y)?.[0] || shadowRoot.elementFromPoint?.(x, y);
      if (!nested || nested === element) break;
      element = nested;
    }
    return element;
  }

  function parentElementAcrossShadow(element) {
    if (element.assignedSlot) return element.assignedSlot;
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  }

  function isSelectable(element) {
    return element instanceof Element && !isOverlayNode(element);
  }

  function describeElement(element) {
    if (!(element instanceof Element)) return "element";
    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : "";
    const classes = [...element.classList].slice(0, 4).map((name) => `.${name}`).join("");
    const rect = element.isConnected ? rectFor(element) : {width: 0, height: 0};
    return `${tag}${id}${classes} [${Math.round(rect.width)}×${Math.round(rect.height)}]`;
  }

  function getElementDescriptor(element) {
    if (!(element instanceof Element)) return {kind: "path", path: [], label: "element", needsConfirmation: true};
    if (state.elementDescriptors.has(element)) return state.elementDescriptors.get(element);
    const panel = element.closest("[data-test-embeddable-id]");
    let descriptor;
    if (panel && isUniqueEmbeddable(panel.dataset.testEmbeddableId)) {
      const panelId = panel.dataset.testEmbeddableId;
      const path = elementPath(panel, element);
      descriptor = path?.length ? {kind: "relative", panelId, path, label: describeElement(element)} : {kind: "embeddable", panelId, label: describeElement(panel)};
    } else {
      const selector = stableSelector(element);
      descriptor = selector
        ? {kind: "selector", selector, label: describeElement(element)}
        : {kind: "path", path: elementPath(document.body, element) || [], label: describeElement(element), needsConfirmation: true};
    }
    state.elementDescriptors.set(element, descriptor);
    return descriptor;
  }

  function stableSelector(element) {
    if (element.id && document.querySelectorAll(`#${escapeCss(element.id)}`).length === 1) return `#${escapeCss(element.id)}`;
    for (const attribute of ["data-testid", "data-test", "name", "aria-label"]) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const selector = `[${attribute}="${escapeAttribute(value)}"]`;
      if (document.querySelectorAll(selector).length === 1) return selector;
    }
    return "";
  }

  function isUniqueEmbeddable(panelId) {
    return Boolean(panelId) && document.querySelectorAll(`[data-test-embeddable-id="${escapeAttribute(panelId)}"]`).length === 1;
  }

  function elementPath(root, element) {
    const path = [];
    let node = element;
    while (node && node !== root) {
      const parent = node.parentElement;
      if (!parent) return null;
      path.unshift([...parent.children].indexOf(node));
      node = parent;
    }
    return node === root ? path : null;
  }

  function resolveElementPath(root, path) {
    let node = root;
    for (const index of path || []) {
      node = node?.children?.[index] || null;
      if (!node) return null;
    }
    return node;
  }

  function resolveProfileTarget(target) {
    let matches = [];
    if (target?.kind === "embeddable") {
      matches = [...document.querySelectorAll(`[data-test-embeddable-id="${escapeAttribute(target.panelId)}"]`)]
        .filter((element) => isValidTarget(element));
    } else if (target?.kind === "relative") {
      const panels = [...document.querySelectorAll(`[data-test-embeddable-id="${escapeAttribute(target.panelId)}"]`)];
      matches = panels.map((panel) => resolveElementPath(panel, target.path)).filter((element) => isValidTarget(element));
    } else if (target?.kind === "selector") {
      try {
        matches = [...document.querySelectorAll(target.selector)].filter((element) => isValidTarget(element));
      } catch {
        matches = [];
      }
    } else if (target?.kind === "path") {
      const element = resolveElementPath(document.body, target.path);
      if (isValidTarget(element)) matches = [element];
    }
    const status = matches.length === 0 ? "missing" : matches.length > 1 ? "ambiguous" : target?.needsConfirmation ? "needs_confirmation" : "resolved";
    return {status, matches, element: matches[0] || null, label: target?.label || "Profile target"};
  }

  function loadProfile(targets) {
    state.paused = true;
    state.history = [];
    state.locked = false;
    state.profileResolution = targets.map((target, index) => ({index, target, ...resolveProfileTarget(target)}));
    state.multiSelection = state.profileResolution.filter((item) => item.status === "resolved" && item.element).map((item) => item.element);
    for (const element of state.multiSelection) getElementDescriptor(element);
    state.current = state.multiSelection[0] || null;
    state.candidates = state.current ? ancestorChain(state.current) : [];
    state.pointDirty = false;
    if (state.host) state.host.style.display = "block";
    refreshInspector();
  }

  function dismissProfileTarget(index) {
    state.profileResolution = state.profileResolution.filter((item) => item.index !== index);
    sendInspectorState();
  }

  function sendInspectorState(statusOverride = "") {
    if (!state.sessionId) return;
    const candidates = state.candidates.filter(isValidTarget);
    const validSelection = state.multiSelection.filter(isValidTarget);
    const invalid = validSelection.length !== state.multiSelection.length;
    const hasTarget = Boolean(validSelection.length || (state.locked && isValidTarget(state.current)));
    const unresolvedProfile = state.profileResolution.some((item) => item.status !== "resolved");
    chrome.runtime.sendMessage({
      type: "INSPECT_STATE",
      sessionId: state.sessionId,
      documentToken: state.documentToken,
      frameId: 0,
      running: state.running,
      paused: state.paused,
      busy: state.busy,
      locked: state.locked,
      currentIndex: candidates.indexOf(state.current),
      current: isValidTarget(state.current) ? {label: describeElement(state.current), descriptor: getElementDescriptor(state.current)} : null,
      candidates: candidates.map((element) => ({label: describeElement(element), descriptor: getElementDescriptor(element)})),
      selection: state.multiSelection.map((element) => ({valid: isValidTarget(element), label: describeElement(element), descriptor: getElementDescriptor(element)})),
      historyLength: state.history.length,
      canCapture: !state.busy && hasTarget && !invalid && !unresolvedProfile,
      status: statusOverride || (unresolvedProfile ? DivSnapI18n.t("profileUnresolved") : invalid ? DivSnapI18n.t("targetInvalid") : DivSnapI18n.t("selectedStatus", {count: state.multiSelection.length, state: DivSnapI18n.t(state.locked ? "previewLocked" : "hoverPreview")})),
      profileResolution: state.profileResolution.map(({index, target, status, label, matches}) => ({index, target, status, label, matchCount: matches.length})),
      page: pageContext()
    });
  }

  function pageContext() {
    const url = new URL(location.href);
    let identity = url.href;
    let label = `${url.host}${url.pathname}`;
    let kind = "page";
    if (/\/app\/dashboards?(?:\/|$)/.test(url.pathname) || /\/app\/dashboard(?:\/|$)/.test(url.pathname)) {
      const space = url.pathname.match(/\/s\/([^/]+)/)?.[1] || "default";
      const dashboardId = url.hash.match(/(?:view|dashboard)\/([^/?]+)/)?.[1] || url.searchParams.get("dashboard") || url.searchParams.get("view") || "unknown";
      identity = `kibana|${url.host}|${space}|${dashboardId}`;
      label = `${url.host} · Kibana ${dashboardId}`;
      kind = "dashboard";
    } else {
      const grafana = url.pathname.match(/\/d(?:-solo)?\/([^/]+)/);
      if (grafana) {
        const org = url.searchParams.get("orgId") || "default";
        identity = `grafana|${url.host}|${org}|${grafana[1]}`;
        label = `${url.host} · Grafana ${grafana[1]}`;
        kind = "dashboard";
      }
    }
    return {kind, label, pageKey: `page-${stableHash(identity)}`};
  }

  function stableHash(value) {
    let hash = 2166136261;
    for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    return (hash >>> 0).toString(16);
  }

  function escapeCss(value) {
    return globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
  }

  function escapeAttribute(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function assertNotCancelled() {
    if (state.cancelled) throw new Error("Capture cancelled.");
  }

  function removeInspector() {
    state.cancelled = true;
    state.mutationObserver?.disconnect();
    state.resizeObserver?.disconnect();
    state.mutationObserver = null;
    state.resizeObserver = null;
    state.observedRoots.clear();
    state.observedElements.clear();
    if (state.frame !== null) cancelAnimationFrame(state.frame);
    state.frame = null;
    for (const remove of state.listeners.splice(0)) remove();
    clearBoxLayers();
    state.multiSelection = [];
    state.profileResolution = [];
    state.locked = false;
    state.lastDAt = 0;
    state.point = null;
    state.pointDirty = false;
    state.candidates = [];
    state.branch = [];
    state.history = [];
    state.rectCache = new WeakMap();
    for (const box of state.selectionBoxes.values()) box.remove();
    state.selectionBoxes.clear();
    state.unionBox?.remove();
    state.unionBox = null;
    state.highlight?.remove();
    state.highlight = null;
    state.label = null;
    state.current = null;
    state.running = false;
    state.paused = false;
    state.busy = false;
    state.captureSnapshot = null;
    state.captureId = null;
    state.captureRequested = false;
    showDivsnapUi();
    sendInspectorState(DivSnapI18n.t("inspectorStopped"));
    state.host?.remove();
    state.host = null;
    state.shadow = null;
  }

  function requestCapture() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({type: "CAPTURE_VISIBLE", sessionId: state.sessionId, documentToken: state.documentToken, captureId: state.captureId}, (response) => {
        const error = chrome.runtime.lastError;
        if (error) return reject(new Error(error.message));
        if (!response?.ok) return reject(new Error(response?.error || "Capture unavailable."));
        resolve(response.dataUrl);
      });
    });
  }

  async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not encode PNG.")), "image/png");
    });
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Captured image could not be decoded."));
      image.src = dataUrl;
    });
  }

  function waitForPaint(frames = 2) {
    return new Promise((resolve) => {
      let remaining = frames;
      const next = () => {
        remaining -= 1;
        if (remaining <= 0) {
          setTimeout(resolve, 50);
        } else {
          requestAnimationFrame(next);
        }
      };
      requestAnimationFrame(next);
    });
  }

  function buildFilename(element) {
    const tag = element.tagName.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const id = element.id ? `-${element.id.replace(/[^a-z0-9_-]/gi, "-").replace(/-+/g, "-")}` : "";
    return `divsnap-${tag}${id}-${buildTimestamp()}`;
  }

  function buildMultiFilename() {
    return `divsnap-multi-${buildTimestamp()}`;
  }

  function buildTimestamp() {
    const date = new Date();
    const stamp = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("") + "-" +
      [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("");
    return stamp;
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function createDocumentToken() {
    return globalThis.crypto?.randomUUID?.() || `document-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
})();
