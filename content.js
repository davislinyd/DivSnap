(() => {
  if (globalThis.__divsnapInspector) return;

  const SHIFT_PATH_STEP = 6;
  const SHIFT_HIT_RADIUS = 6;
  const SHIFT_HIT_OFFSETS = [
    {x: 0, y: 0},
    {x: -SHIFT_HIT_RADIUS, y: 0},
    {x: SHIFT_HIT_RADIUS, y: 0},
    {x: 0, y: -SHIFT_HIT_RADIUS},
    {x: 0, y: SHIFT_HIT_RADIUS},
    {x: -SHIFT_HIT_RADIUS / Math.SQRT2, y: -SHIFT_HIT_RADIUS / Math.SQRT2},
    {x: SHIFT_HIT_RADIUS / Math.SQRT2, y: -SHIFT_HIT_RADIUS / Math.SQRT2},
    {x: -SHIFT_HIT_RADIUS / Math.SQRT2, y: SHIFT_HIT_RADIUS / Math.SQRT2},
    {x: SHIFT_HIT_RADIUS / Math.SQRT2, y: SHIFT_HIT_RADIUS / Math.SQRT2}
  ];

  const state = {
    host: null,
    shadow: null,
    highlight: null,
    label: null,
    boxLayers: [],
    current: null,
    multiSelection: [],
    shiftSelecting: false,
    lastShiftPoint: null,
    shiftHoverTarget: null,
    listeners: [],
    running: false,
    busy: false,
    hudTimer: null
  };

  globalThis.__divsnapInspector = {start};

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "START_INSPECT") return false;
    start()
      .then(() => sendResponse({ok: true}))
      .catch((error) => sendResponse({ok: false, error: error.message || String(error)}));
    return true;
  });

  async function start() {
    if (state.running) return;
    state.running = true;
    state.busy = false;
    await createOverlay();
    addListener(window, "mousedown", onMouseDown, true);
    addListener(window, "mousemove", onMouseMove, true);
    addListener(window, "click", onClick, true);
    addListener(window, "keydown", onKeyDown, true);
    updateFromPoint(innerWidth / 2, innerHeight / 2);
  }

  async function createOverlay() {
    if (state.host?.isConnected && state.highlight) return;
    if (state.host?.isConnected) {
      clearTimeout(state.hudTimer);
      state.host.remove();
      state.host = null;
      state.shadow = null;
    }
    const host = document.createElement("div");
    host.setAttribute("data-divsnap-overlay", "true");
    host.style.position = "fixed";
    host.style.inset = "0";
    host.style.zIndex = "2147483647";
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
  }

  function addListener(target, type, listener, capture = false) {
    target.addEventListener(type, listener, capture);
    state.listeners.push(() => target.removeEventListener(type, listener, capture));
  }

  function onMouseDown(event) {
    if (!state.running || state.busy || event.button !== 0) return;
    if (!state.multiSelection.length || event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function onMouseMove(event) {
    if (!state.running || state.busy) return;
    if (event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (!state.shiftSelecting) {
        state.shiftSelecting = true;
        state.multiSelection = [];
        state.lastShiftPoint = null;
        state.shiftHoverTarget = null;
        state.current = null;
        clearBoxLayers();
        state.highlight.style.display = "none";
        state.label.textContent = "";
      }
      collectShiftSelection(event.clientX, event.clientY);
      return;
    }
    if (state.multiSelection.length) return;
    updateFromPoint(event.clientX, event.clientY);
  }

  function onClick(event) {
    if (!state.running || state.busy) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (state.multiSelection.length) {
      state.busy = true;
      finishSelection(state.multiSelection.slice(), true).catch((error) => {
        removeInspector(true);
        showHud(`Capture failed / 截圖失敗：${error.message || String(error)}`, "error");
      });
      return;
    }
    const target = deepElementFromPoint(event.clientX, event.clientY);
    if (!isSelectable(target)) return;
    state.current = target;
    state.busy = true;
    finishSelection([target], false).catch((error) => {
      removeInspector(true);
      showHud(`Capture failed / 截圖失敗：${error.message || String(error)}`, "error");
    });
  }

  function onKeyDown(event) {
    if (!state.running || state.busy) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      removeInspector(false);
      return;
    }
    if (state.multiSelection.length) return;
    if (!state.current) return;
    let next = null;
    if (event.key === "ArrowUp") next = parentElementAcrossShadow(state.current);
    if (event.key === "ArrowDown") next = state.current.firstElementChild;
    if (event.key === "ArrowLeft") next = state.current.previousElementSibling;
    if (event.key === "ArrowRight") next = state.current.nextElementSibling;
    if (!isSelectable(next)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    state.current = next;
    paintTarget(next);
  }

  function updateFromPoint(x, y) {
    const target = deepElementFromPoint(x, y);
    if (!isSelectable(target)) return;
    state.current = target;
    paintTarget(target);
  }

  function paintTarget(target) {
    if (!state.highlight || !target?.getBoundingClientRect) return;
    const rect = target.getBoundingClientRect();
    state.highlight.style.display = "block";
    state.highlight.dataset.mode = "single";
    state.highlight.style.left = `${rect.left}px`;
    state.highlight.style.top = `${rect.top}px`;
    state.highlight.style.width = `${Math.max(0, rect.width)}px`;
    state.highlight.style.height = `${Math.max(0, rect.height)}px`;
    state.label.textContent = describeElement(target);
    state.label.dataset.below = rect.top < 36 ? "true" : "false";
    paintBoxModel(target, rect);
  }

  function collectShiftSelection(x, y) {
    const points = sampleMousePath(state.lastShiftPoint, {x, y});
    for (const point of points) {
      let preferred = null;
      for (const offset of SHIFT_HIT_OFFSETS) {
        const hitX = point.x + offset.x;
        const hitY = point.y + offset.y;
        if (hitX < 0 || hitX >= innerWidth || hitY < 0 || hitY >= innerHeight) continue;
        const target = shiftDivAtPoint(hitX, hitY);
        if (!target) continue;
        addShiftCandidate(target);
        if (!preferred || isAncestorOf(preferred, target)) preferred = target;
      }
      if (preferred) state.shiftHoverTarget = preferred;
    }
    state.lastShiftPoint = {x, y};
    if (state.multiSelection.length) paintMultiSelection(state.multiSelection);
  }

  function sampleMousePath(from, to) {
    if (!from) return [to];
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(distance / SHIFT_PATH_STEP));
    return Array.from({length: steps}, (_, index) => {
      const progress = (index + 1) / steps;
      return {
        x: from.x + (to.x - from.x) * progress,
        y: from.y + (to.y - from.y) * progress
      };
    });
  }

  function shiftDivAtPoint(x, y) {
    const hitElement = deepElementFromPoint(x, y);
    let element = hitElement;
    while (element) {
      if (element.tagName?.toLowerCase() === "div") {
        if (state.shiftHoverTarget && isAncestorOf(element, state.shiftHoverTarget) &&
            pointInsideExpandedRect(x, y, state.shiftHoverTarget, SHIFT_HIT_RADIUS)) {
          return state.shiftHoverTarget;
        }
        return isShiftCandidate(element, hitElement, x, y) ? element : null;
      }
      element = parentElementAcrossShadow(element);
    }
    return null;
  }

  function addShiftCandidate(candidate) {
    if (!isShiftDivCandidate(candidate)) return;
    if (state.multiSelection.some((selected) => isAncestorOf(candidate, selected))) return;
    state.multiSelection = state.multiSelection.filter((selected) => !isAncestorOf(selected, candidate));
    if (!state.multiSelection.includes(candidate)) state.multiSelection.push(candidate);
  }

  function isShiftDivCandidate(element) {
    if (!isSelectable(element) || element.tagName?.toLowerCase() !== "div") return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.width >= innerWidth * 0.9 && rect.height >= innerHeight * 0.9) return false;
    return true;
  }

  function isShiftCandidate(element, hitElement, x, y) {
    if (!isShiftDivCandidate(element)) return false;
    if (hitElement !== element || !hasStructuralChildren(element)) return true;
    return hasOwnTextAtPoint(element, x, y);
  }

  function hasStructuralChildren(element) {
    if (element.children?.length) return true;
    return element.shadowRoot?.mode === "open" && Boolean(element.shadowRoot.children?.length);
  }

  function hasOwnTextAtPoint(element, x, y) {
    return hasTextNodeAtPoint(element.childNodes, x, y) ||
      (element.shadowRoot?.mode === "open" && hasTextNodeAtPoint(element.shadowRoot.childNodes, x, y));
  }

  function hasTextNodeAtPoint(nodes, x, y) {
    for (const node of nodes || []) {
      if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
      }
    }
    return false;
  }

  function pointInsideExpandedRect(x, y, element, padding) {
    const rect = element.getBoundingClientRect();
    return x >= rect.left - padding && x <= rect.right + padding &&
      y >= rect.top - padding && y <= rect.bottom + padding;
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

  function paintMultiSelection(elements) {
    const bounds = unionViewportRegion(elements);
    if (!bounds) return;
    clearBoxLayers();
    state.highlight.style.display = "block";
    state.highlight.dataset.mode = "multi";
    state.highlight.style.left = `${bounds.left}px`;
    state.highlight.style.top = `${bounds.top}px`;
    state.highlight.style.width = `${bounds.width}px`;
    state.highlight.style.height = `${bounds.height}px`;
    state.label.textContent = `Selected ${elements.length} divs / 已選取 ${elements.length} 個 div`;
    state.label.dataset.below = bounds.top < 36 ? "true" : "false";
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

  async function finishSelection(elements, multi) {
    const settings = await chrome.storage.sync.get({
      copyToClipboard: true,
      downloadPng: true,
      captureMode: "visible"
    });
    if (!settings.copyToClipboard && !settings.downloadPng) {
      removeInspector(true);
      showHud("No output selected / 尚未選擇輸出方式", "warning");
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    let result;
    removeInspector(false);
    await waitForPaint();
    if (multi) {
      result = settings.captureMode === "full"
        ? await captureFullMulti(elements, dpr)
        : await captureVisibleMulti(elements, dpr);
    } else {
      result = settings.captureMode === "full"
        ? await captureFull(elements[0], dpr)
        : await captureVisible(elements[0], dpr);
    }
    const blob = await canvasToBlob(result.canvas);
    const messages = [];
    if (result.notice) messages.push(result.notice);
    if (result.clipped) messages.push("Visible crop / 已裁切至可見範圍");

    const tasks = [];
    if (settings.copyToClipboard) {
      tasks.push(copyToClipboard(blob).then(() => messages.push("Copied / 已複製")).catch((error) => {
        messages.push(`Clipboard failed / 複製失敗：${error.message || String(error)}`);
      }));
    }
    if (settings.downloadPng) {
      const filename = multi ? buildMultiFilename() : buildFilename(elements[0]);
      tasks.push(downloadPng(blob, filename).then(() => messages.push("PNG downloaded / 已下載 PNG")).catch((error) => {
        messages.push(`Download failed / 下載失敗：${error.message || String(error)}`);
      }));
    }
    await Promise.all(tasks);
    const kind = messages.some((message) => /failed|失敗/.test(message))
      ? "error"
      : result.notice
        ? "warning"
        : "info";
    showHud(messages.join(" · "), kind);
  }

  async function captureVisible(target, dpr) {
    target.scrollIntoView({block: "nearest", inline: "nearest"});
    await waitForPaint();
    return captureVisibleRegion(target.getBoundingClientRect(), dpr);
  }

  async function captureVisibleMulti(elements, dpr) {
    const region = unionViewportRegion(elements);
    if (!region) throw new Error("Selected divs are no longer available.");
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
    if (!ancestors) {
      const fallback = await captureVisibleMulti(elements, dpr);
      return {...fallback, notice: "Different scroll containers / 不同捲動容器，改用 Visible"};
    }
    const region = unionLayoutRegion(elements, ancestors);
    if (!region || region.width <= 0 || region.height <= 0) {
      throw new Error("Selected divs have no capture area.");
    }
    if (region.width * dpr > 8192 || region.height * dpr > 8192) {
      const fallback = await captureVisibleMulti(elements, dpr);
      return {...fallback, notice: "Full exceeds 8192px / 超過限制，改用 Visible"};
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
          const localLeft = clamp(visible.left + layoutScrollOffset(ancestors).x - region.left, 0, region.width);
          const localTop = clamp(visible.top + layoutScrollOffset(ancestors).y - region.top, 0, region.height);
          const localRight = clamp(visible.right + layoutScrollOffset(ancestors).x - region.left, 0, region.width);
          const localBottom = clamp(visible.bottom + layoutScrollOffset(ancestors).y - region.top, 0, region.height);
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
    const width = Math.max(1, target.offsetWidth);
    const height = Math.max(1, target.offsetHeight);
    const snapshot = saveScrollPositions(target);
    if (width * dpr > 8192 || height * dpr > 8192) {
      try {
        const fallback = await captureVisible(target, dpr);
        return {...fallback, notice: "Full exceeds 8192px / 超過限制，改用 Visible"};
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
      if (pointX < ancestorRect.left) ancestor.scrollLeft -= ancestorRect.left - pointX;
      else if (pointX >= ancestorRect.right) ancestor.scrollLeft += pointX - ancestorRect.right + 1;
      if (pointY < ancestorRect.top) ancestor.scrollTop -= ancestorRect.top - pointY;
      else if (pointY >= ancestorRect.bottom) ancestor.scrollTop += pointY - ancestorRect.bottom + 1;
    }
    const targetRect = target.getBoundingClientRect();
    const pointX = targetRect.left + localX;
    const pointY = targetRect.top + localY;
    if (pointX < 0 || pointX >= innerWidth) window.scrollBy(pointX < 0 ? pointX : pointX - innerWidth + 1, 0);
    if (pointY < 0 || pointY >= innerHeight) window.scrollBy(0, pointY < 0 ? pointY : pointY - innerHeight + 1);
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
      if (point.x < rect.left) ancestor.scrollLeft -= rect.left - point.x;
      else if (point.x >= rect.right) ancestor.scrollLeft += point.x - rect.right + 1;
      if (point.y < rect.top) ancestor.scrollTop -= rect.top - point.y;
      else if (point.y >= rect.bottom) ancestor.scrollTop += point.y - rect.bottom + 1;
    }
    const point = layoutViewportPoint(x, y, ancestors);
    if (point.x < 0 || point.x >= innerWidth) window.scrollBy(point.x < 0 ? point.x : point.x - innerWidth + 1, 0);
    if (point.y < 0 || point.y >= innerHeight) window.scrollBy(0, point.y < 0 ? point.y : point.y - innerHeight + 1);
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
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  }

  function isSelectable(element) {
    return element instanceof Element && element !== state.host && !state.host?.contains(element);
  }

  function describeElement(element) {
    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : "";
    const classes = [...element.classList].slice(0, 4).map((name) => `.${name}`).join("");
    const rect = element.getBoundingClientRect();
    return `${tag}${id}${classes} [${Math.round(rect.width)}×${Math.round(rect.height)}]`;
  }

  function removeInspector(keepHud) {
    for (const remove of state.listeners.splice(0)) remove();
    clearBoxLayers();
    state.multiSelection = [];
    state.shiftSelecting = false;
    state.lastShiftPoint = null;
    state.shiftHoverTarget = null;
    state.highlight?.remove();
    state.highlight = null;
    state.label = null;
    state.current = null;
    state.running = false;
    if (!keepHud) {
      clearTimeout(state.hudTimer);
      state.host?.remove();
      state.host = null;
      state.shadow = null;
    }
  }

  function showHud(message, kind = "info") {
    if (!state.host) {
      state.host = document.createElement("div");
      state.host.setAttribute("data-divsnap-overlay", "true");
      state.host.style.position = "fixed";
      state.host.style.inset = "0";
      state.host.style.zIndex = "2147483647";
      state.host.style.display = "block";
      state.host.style.pointerEvents = "none";
      state.shadow = state.host.attachShadow({mode: "open"});
      const style = document.createElement("style");
      fetch(chrome.runtime.getURL("overlay.css")).then((response) => response.text()).then((css) => style.textContent = css).catch(() => {});
      const root = document.createElement("div");
      root.className = "divsnap-root";
      state.shadow.append(style, root);
      (document.documentElement || document.body).append(state.host);
    }
    const hud = document.createElement("div");
    hud.className = "divsnap-hud";
    hud.dataset.kind = kind;
    hud.textContent = message;
    state.shadow.querySelector(".divsnap-root").append(hud);
    clearTimeout(state.hudTimer);
    state.hudTimer = setTimeout(() => {
      state.host?.remove();
      state.host = null;
      state.shadow = null;
    }, 2500);
  }

  function requestCapture() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({type: "CAPTURE_VISIBLE"}, (response) => {
        const error = chrome.runtime.lastError;
        if (error) return reject(new Error(error.message));
        if (!response?.ok) return reject(new Error(response?.error || "Capture unavailable."));
        resolve(response.dataUrl);
      });
    });
  }

  async function copyToClipboard(blob) {
    if (!navigator.clipboard?.write || !globalThis.ClipboardItem) throw new Error("Clipboard API unavailable.");
    await navigator.clipboard.write([new ClipboardItem({"image/png": blob})]);
  }

  function downloadPng(blob, filename) {
    return new Promise(async (resolve, reject) => {
      try {
        const buffer = await blob.arrayBuffer();
        const bufferBase64 = arrayBufferToBase64(buffer);
        chrome.runtime.sendMessage({type: "DOWNLOAD_PNG", filename, bufferBase64}, (response) => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else if (!response?.ok) reject(new Error(response?.error || "Download unavailable."));
          else resolve(response.downloadId);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
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
    return `divsnap-${tag}${id}-${buildTimestamp()}.png`;
  }

  function buildMultiFilename() {
    return `divsnap-multi-${buildTimestamp()}.png`;
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
})();
