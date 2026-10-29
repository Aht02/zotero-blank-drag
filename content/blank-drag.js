/* global Zotero, setInterval, clearInterval */
"use strict";

// Zotero 10.0.6 adapter. No prototype patches or persistent reader changes.
var BlankDrag = (() => {
  const ID = "blank-drag@aht02.github.io";
  const ATTRIBUTE = "data-zotero-blank-drag";
  const HOVER_ATTRIBUTE = "data-zotero-blank-drag-hover";
  const INTERACTIVE = [
    "a", "button", "input", "textarea", "select", "option", "label",
    "[contenteditable]:not([contenteditable='false'])", "[role='button']",
    "[role='link']", "[role='textbox']", ".textAnnotation", ".annotationLayer",
    ".popup", "[data-annotation-id]", "audio", "video"
  ].join(",");

  function containsPoint(rect, x, y, padding = 0) {
    return rect?.length === 4
      && x >= Math.min(rect[0], rect[2]) - padding
      && x <= Math.max(rect[0], rect[2]) + padding
      && y >= Math.min(rect[1], rect[3]) - padding
      && y <= Math.max(rect[1], rect[3]) + padding;
  }

  function isLeftMouse(event) {
    return (!event.pointerType || event.pointerType === "mouse")
      && event.button === 0 && event.isPrimary !== false;
  }

  function scrollbarKind(container, event) {
    // Gecko retargets native anonymous scrollbar events to viewerContainer.
    // Overlay scrollbars consume NO clientWidth, so geometry alone misses them.
    try {
      let node = event.originalTarget || event.target;
      let part = false;
      for (let i = 0; node && i < 8; i++, node = node.parentNode) {
        const name = node.localName;
        if (name === "scrollcorner") return "corner";
        if (["scrollbar", "scrollbarbutton", "slider", "thumb"].includes(name)) {
          part = true;
          const axis = node.getAttribute?.("orient");
          if (axis === "vertical" || axis === "horizontal") return axis;
        }
        if (node === container) break;
      }
      if (part) return "unknown";
    } catch (_) {
      // Native GrabToPan also declines inaccessible originalTarget nodes.
      return "unknown";
    }
    const bounds = container.getBoundingClientRect();
    const { clientX: x, clientY: y } = event;
    if (x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom) return null;
    const left = bounds.left + container.clientLeft;
    const top = bounds.top + container.clientTop;
    const vertical = x < left || x >= left + container.clientWidth;
    const horizontal = y < top || y >= top + container.clientHeight;
    return vertical && horizontal ? "corner" : vertical ? "vertical" : horizontal ? "horizontal" : null;
  }

  // Fail closed: if page data or an internal API isn't ready, let Zotero handle it.
  function canStart(view, container, event, hover = false) {
    const validInput = hover
      ? event.pointerType === "mouse" && !event.buttons
      : isLeftMouse(event) && !(event.detail > 1);
    if (!validInput || event.defaultPrevented
      || view._tool?.type !== "pointer" || view._suspended
      || view._nativeTextSelection?.enabled) return false;
    const hitTarget = hover
      ? view._iframeWindow.document.elementFromPoint(event.clientX, event.clientY) : event.target;
    const target = hitTarget?.nodeType === 1 ? hitTarget : hitTarget?.parentElement;
    if (!target || !container.contains(target) || target.closest(INTERACTIVE)) return false;
    if (scrollbarKind(container, event)) return false;

    // Exclude native scrollbars, including left-side scrollbars in RTL layouts.
    const bounds = container.getBoundingClientRect();
    const left = bounds.left + container.clientLeft;
    const top = bounds.top + container.clientTop;
    if (event.clientX < left || event.clientX >= left + container.clientWidth
      || event.clientY < top || event.clientY >= top + container.clientHeight) return false;

    const position = view.pointerEventToPosition(event);
    if (!position) return !target.closest(".page");
    const chars = view._pdfPages?.[position.pageIndex]?.chars;
    if (!Array.isArray(chars)) return false;
    if (view._getSelectableOverlay(position)) return false;
    // Alt changes Zotero's action lookup to selectText even over annotations.
    // Keep annotations and their resize handles protected with any modifier held.
    if (view.getSelectableAnnotations?.(position)?.length) return false;
    const selected = view.getSelectedAnnotations?.();
    if (selected?.length === 1 && view.getSelectedAnnotationAction?.(selected[0], position)) return false;
    const result = view.getActionAtPosition(position, event);
    if (!result || !["selectText", "none"].includes(result.action?.type)
      || result.selectAnnotations?.length) return false;

    const page = view._iframeWindow.PDFViewerApplication.pdfViewer._pages[position.pageIndex];
    const scale = page?.viewport?.scale;
    if (!Number.isFinite(scale) || scale <= 0) return false;
    const [x, y] = position.rects[0];
    // A 2 CSS-pixel safety margin makes starting selections at glyph edges easy.
    // Coordinates are PDF coordinates, so this also works with zoom and rotation.
    const padding = 2 / scale;
    return !chars.some(char => containsPoint(char.rect, x, y, padding));
  }

  class Controller {
    constructor(view, reportError) {
      this.view = view;
      this.win = view._iframeWindow;
      this.doc = this.win.document;
      this.container = this.doc.getElementById("viewerContainer");
      this.reportError = reportError;
      this.listeners = [];
      this.nativeHand = null;
      this.drag = null;
      this.suppressClick = false;
      this.destroyed = false;
      this.hoverEvent = null;
      this.style = this.doc.createElement("style");
      this.style.textContent = `html[${HOVER_ATTRIBUTE}] #viewerContainer,
        html[${HOVER_ATTRIBUTE}] #viewerContainer * { cursor: default !important; }
        html[${ATTRIBUTE}] #viewerContainer {
          scroll-behavior: auto !important;
        }
        html[${ATTRIBUTE}] #viewerContainer,
        html[${ATTRIBUTE}] #viewerContainer * {
          cursor: grabbing !important;
        }`;
      this.doc.documentElement.appendChild(this.style);

      // Take ownership in pointerdown, before native mousedown builds a text
      // selection and renders it. Text-start gestures still remain fully native.
      this.listen(this.win, "pointerdown", event => this.onPointerDown(event), true);
      this.listen(this.win, "mousedown", event => this.onMouseDown(event), true);
      this.listen(this.win, "pointermove", event => this.onMove(event), true);
      this.listen(this.win, "pointerup", event => this.onUp(event), true);
      // A non-root element defaults wheel listeners to non-passive. Use the
      // primitive capture argument: chrome-realm option dictionaries are not
      // reliably readable through Gecko's waived content compartment wrapper.
      this.listen(this.container, "wheel", event => this.onWheel(event), true);
      this.listen(this.container, "pointerleave", () => this.clearHover(), false);
      this.listen(this.doc, "scroll", () => {
        if (this.hoverEvent) this.updateHover(this.hoverEvent);
      }, true);
      this.listen(this.win, "pointercancel", () => this.finish(), true);
      this.listen(this.win, "blur", () => this.finish(), false);
      this.listen(this.doc, "visibilitychange", () => {
        if (this.doc.hidden) this.finish();
      }, false);
      this.listen(this.win, "keydown", event => {
        if (this.drag && event.key === "Escape") {
          this.finish();
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, true);
      this.listen(this.win, "dragstart", event => {
        if (this.drag) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, true);
      this.listen(this.win, "click", event => {
        if (this.suppressClick) {
          this.suppressClick = false;
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, true);
    }

    listen(target, type, callback, capture) {
      const guarded = event => {
        try { callback(event); }
        catch (error) { this.finish(); this.reportError(error); }
      };
      target.addEventListener(type, guarded, capture);
      this.listeners.push(() => target.removeEventListener(type, guarded, capture));
    }

    onPointerDown(event) {
      // Hit-test before changing cursor styles, so layout reads cannot expose I-beam.
      const eligible = event.pointerType === "mouse" && canStart(this.view, this.container, event);
      this.finish();
      this.suppressClick = false;
      if (eligible) {
        const cursorTools = this.win.PDFViewerApplication.pdfCursorTools;
        if (cursorTools?.activeTool !== 0) return;
        const hand = cursorTools._handTool;
        if (typeof hand?.activate !== "function" || typeof hand?.deactivate !== "function") return;
        this.nativeHand = hand;
        this.doc.documentElement.setAttribute(ATTRIBUTE, "");
        this.beginDrag(event, { pointerId: event.pointerId, x: event.clientX, y: event.clientY });
      }
    }

    onMouseDown(event) {
      if (!this.drag) return;
      // Let this real mousedown reach the native GrabToPan container listener.
      if (scrollbarKind(this.container, event)) { this.finish(); return; }
      if (!isLeftMouse(event) || event.detail > 1 || event.defaultPrevented
        || this.view._tool?.type !== "pointer") { this.finish(); return; }
      // Another extension may have changed the action after our pointerdown test.
      if (this.view.action && !["selectText", "none"].includes(this.view.action.type)) {
        this.finish();
        return;
      }
      this.view._clearPointerAction();
      this.view._pointerDownTriggered = true;
    }

    onWheel(event) {
      // Only the PDF's vertical scrollbar column gets fast scrolling. Keep
      // native zoom, horizontal/modified wheel, page-mode wheel and held buttons.
      if (event.defaultPrevented || event.cancelable === false || this.drag
        || this.view._suspended || event.buttons || event.ctrlKey || event.metaKey
        || event.shiftKey || event.altKey || event.deltaX || !Number.isFinite(event.deltaY)
        || !event.deltaY || ![0, 1].includes(event.deltaMode)
        || !this.container.contains(event.target)
        || scrollbarKind(this.container, event) !== "vertical") return;
      const height = this.container.clientHeight;
      if (height <= 0 || this.container.scrollHeight <= height) return;
      // SumatraPDF FastScrollOverScrollbar uses half a viewport per wheel event.
      // Pixel-mode touchpads retain proportional fine motion (100 px = one step).
      const step = event.deltaMode === 0
        ? Math.max(-1, Math.min(1, event.deltaY / 100)) : Math.sign(event.deltaY);
      const top = Math.max(0, Math.min(this.container.scrollHeight - height,
        this.container.scrollTop + step * height / 2));
      this.container.scrollTo(this.container.scrollLeft, top);
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    beginDrag(event, pending) {
      this.view._clearPointerAction();
      this.drag = {
        ...pending, moved: false
      };
      // Use Zotero/PDF.js's actual engine, without changing the toolbar tool.
      // No plugin pointer capture or pointermove scroll writes: GrabToPan owns
      // native mousedown/mousemove, its instant scrolling and full-window overlay.
      this.nativeHand.activate();
      // Skip Zotero's selection handler, but preserve real compatibility mouse
      // events: canceling pointerdown would also suppress GrabToPan's mousedown.
      this.view._pointerDownTriggered = true;
      let dirty = false;
      if (this.view._selectionRanges?.length || this.win.getSelection?.()?.isCollapsed === false) {
        this.view.clearSelection?.();
        dirty = true;
      }
      if (this.view._selectedAnnotationIDs?.length) {
        // slice executes in the content realm, preserving the array's compartment.
        this.view._onSelectAnnotations?.(this.view._selectedAnnotationIDs.slice(0, 0), event);
        dirty = true;
      }
      if (dirty) this.view._render?.();
    }

    onMove(event) {
      const drag = this.drag;
      if (!drag) { this.updateHover(event); return; }
      if (event.pointerId !== drag.pointerId) return;
      if (!(event.buttons & 1) || this.view._tool?.type !== "pointer") {
        this.finish();
        return;
      }
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      // Track only click suppression here. Actual motion is handled exclusively
      // by the reader's native mousemove handler, in its own content realm.
      if (dx !== 0 || dy !== 0) {
        drag.moved = true;
      }
      event.stopImmediatePropagation();
    }

    onUp(event) {
      if (this.drag && event.pointerId !== this.drag.pointerId) return;
      // Remove the native full-window overlay before hit-testing the release.
      // The pressed cursor override remains applied until finish().
      this.stopNativeHand();
      // Determine the release cursor while the pressed cursor still covers Zotero's.
      const mouseHover = event.pointerType === "mouse" && !event.buttons;
      const blank = mouseHover && canStart(this.view, this.container, event, true);
      this.finish();
      if (mouseHover) this.hoverEvent = event;
      this.setHover(blank);
      // Zotero's own pointerup still runs to update its cursor and view stats.
    }

    finish() {
      this.stopNativeHand();
      this.clearHover();
      const drag = this.drag;
      this.drag = null;
      if (drag) {
        this.view._pointerDownTriggered = false;
        this.suppressClick = drag.moved;
      }
      this.doc.documentElement.removeAttribute(ATTRIBUTE);
    }

    stopNativeHand() {
      const hand = this.nativeHand;
      this.nativeHand = null;
      if (!hand) return;
      hand.deactivate();
      // A user may switch to the global native hand during the gesture. End our
      // pan, but don't leave their newly selected tool deactivated.
      if (this.win.PDFViewerApplication.pdfCursorTools.activeTool === 1) hand.activate();
    }

    updateHover(event) {
      if (this.drag || event.pointerType !== "mouse" || event.buttons) {
        this.clearHover();
        return;
      }
      this.hoverEvent = event;
      // Keep the previous cursor in place during hit testing. elementFromPoint()
      // and getBoundingClientRect() flush styles; removing the override first
      // briefly exposes Zotero's I-beam on every move. Mutate only on transitions.
      this.setHover(canStart(this.view, this.container, event, true));
    }

    setHover(active) {
      const root = this.doc.documentElement;
      if (root.hasAttribute(HOVER_ATTRIBUTE) === active) return;
      if (active) root.setAttribute(HOVER_ATTRIBUTE, "");
      else root.removeAttribute(HOVER_ATTRIBUTE);
    }

    clearHover() {
      this.hoverEvent = null;
      this.setHover(false);
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.finish();
      for (const remove of this.listeners.splice(0)) {
        try { remove(); } catch (_) { /* Closed reader. */ }
      }
      this.style.remove();
    }
  }

  const controllers = new Map();
  let timer = null;
  let running = false;
  const reportError = error => Zotero.logError(error);

  function scan() {
    if (!running) return;
    const current = new Set();
    for (const reader of Zotero.Reader._readers || []) {
      try {
        const internal = reader._internalReader;
        if (internal?._type !== "pdf") continue;
        for (const view of [internal._primaryView, internal._secondaryView]) {
          if (!view || view._suspended || !view._iframe?.isConnected) continue;
          const win = view._iframeWindow;
          if (!win || win.closed || !win.document.getElementById("viewerContainer")
            || !win.PDFViewerApplication?.pdfViewer || !view._autoScroll
            || typeof view.pointerEventToPosition !== "function"
            || typeof view.getActionAtPosition !== "function"
            || typeof view._getSelectableOverlay !== "function"
            || typeof view._clearPointerAction !== "function") continue;
          current.add(view);
          const previous = controllers.get(view);
          if (previous && previous.doc !== win.document) {
            previous.destroy();
            controllers.delete(view);
          }
          if (!controllers.has(view)) controllers.set(view, new Controller(view, reportError));
          // Tool switches can happen with the mouse stationary.
          if (view._tool?.type !== "pointer") controllers.get(view).clearHover();
        }
      } catch (error) { reportError(error); }
    }
    for (const [view, controller] of controllers) {
      if (!current.has(view)) {
        try { controller.destroy(); } catch (error) { reportError(error); }
        controllers.delete(view);
      }
    }
  }

  function start() {
    if (running) return;
    running = true;
    Zotero.Reader.registerEventListener("renderToolbar", scan, ID);
    // Also catches already-open documents, split creation, reloads and closed tabs.
    // Only inspect view references here; hit testing happens during pointer interaction.
    timer = setInterval(scan, 500);
    scan();
  }

  function stop() {
    running = false;
    if (timer !== null) clearInterval(timer);
    timer = null;
    Zotero.Reader.unregisterEventListener("renderToolbar", scan);
    for (const controller of controllers.values()) {
      try { controller.destroy(); } catch (error) { reportError(error); }
    }
    controllers.clear();
  }

  return { start, stop, canStart, scrollbarKind, Controller };
})();
