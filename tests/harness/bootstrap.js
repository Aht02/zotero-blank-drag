/* global Zotero, Services, IOUtils, PathUtils, setTimeout, setInterval, clearInterval, ChromeUtils */
"use strict";
function startup() { setTimeout(run, 1000); }
function shutdown() {}
function install() {}
function uninstall() {}

async function run() {
  const root = Services.prefs.getStringPref("blankDrag.testRoot");
  const report = { version: Zotero.version, tests: [], events: [] };
  const output = PathUtils.join(root, ".test-results", "integration.json");
  const save = () => IOUtils.writeUTF8(output, JSON.stringify(report, null, 2));
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (name, condition, detail) => {
    report.tests.push({ name, passed: !!condition, detail });
    if (!condition) throw new Error(name + ": " + JSON.stringify(detail));
  };
  const waitFor = async (name, fn) => {
    for (let n = 0; n < 150; n++) {
      const result = fn();
      if (result) return result;
      await delay(200);
    }
    throw new Error("Timed out: " + name);
  };
  try {
    await save();
    await Zotero.initializationPromise;
    await Zotero.uiReadyPromise;
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const manifest = JSON.parse(await IOUtils.readUTF8(PathUtils.join(root, "manifest.json")));
    report.pluginVersion = manifest.version;
    const install = await AddonManager.getInstallForFile(Zotero.File.pathToFile(
      PathUtils.join(root, "dist", `zotero-blank-drag-${manifest.version}.xpi`)));
    await install.install();
    const addon = await AddonManager.getAddonByID("blank-drag@aht02.github.io");
    check("product addon loaded", addon?.isActive, { active: addon?.isActive });
    check("built XPI installed", addon.getResourceURI("bootstrap.js").spec.startsWith("jar:"),
      addon.getResourceURI("bootstrap.js").spec);
    const attachment = await Zotero.Attachments.importFromFile({
      file: PathUtils.join(root, ".test-results", "fixture.pdf")
    });
    const reader = await Zotero.Reader.open(attachment.id);
    const view = await waitFor("PDF view", () => reader._internalReader?._primaryView);
    await view.initializedPromise;
    const win = view._iframeWindow;
    const doc = win.document;
    const container = doc.getElementById("viewerContainer");
    await waitFor("page characters", () => view._pdfPages[0]?.chars?.length);
    await waitFor("plugin attached", () => [...doc.querySelectorAll("style")]
      .some(style => style.textContent.includes("data-zotero-blank-drag")));
    await delay(800);
    const scope = { Zotero, setInterval, clearInterval };
    Services.scriptloader.loadSubScript(Services.io.newFileURI(Zotero.File.pathToFile(
      PathUtils.join(root, "content", "blank-drag.js"))).spec, scope);
    const api = scope.BlankDrag;
    const page = win.PDFViewerApplication.pdfViewer._pages[0];
    const atPdfPoint = (x, y) => {
      const [vx, vy] = page.viewport.convertToViewportPoint(x, y);
      const r = page.div.getBoundingClientRect();
      const clientX = vx + r.left;
      const clientY = vy + r.top;
      return Components.utils.cloneInto({ target: doc.elementFromPoint(clientX, clientY), clientX, clientY,
        button: 0, buttons: 1, pointerType: "mouse", isPrimary: true, detail: 1 }, win, { wrapReflectors: true });
    };
    let blank = atPdfPoint(400, 600);
    const ch = view._pdfPages[0].chars[2].rect;
    let text = atPdfPoint((ch[0] + ch[2]) / 2, (ch[1] + ch[3]) / 2);
    report.geometry = { blank: [blank.clientX, blank.clientY], text: [text.clientX, text.clientY],
      container: [container.clientWidth, container.clientHeight], char: ch };
    check("real PDF blank hit", api.canStart(view, container, blank));
    check("real PDF glyph protected", !api.canStart(view, container, text));
    check("Shift allows blank dragging", api.canStart(view, container,
      Components.utils.cloneInto({ ...blank, shiftKey: true }, win, { wrapReflectors: true })));
    await save();

    let lastWheel = null;
    await addon.disable();
    for (const type of ["pointerdown", "mousedown", "pointermove", "pointerup", "mouseup", "wheel"]) {
      win.addEventListener(type, event => {
        if (type === "wheel") lastWheel = event;
        report.events.push({ type, pointerType: event.pointerType, pointerId: event.pointerId,
        buttons: event.buttons, x: event.clientX, y: event.clientY,
        nativeAction: view.action?.type, selectionCount: view._selectionRanges.length,
        shift: event.shiftKey, control: event.ctrlKey, alt: event.altKey, meta: event.metaKey,
        defaultPrevented: event.defaultPrevented });
      }, true);
    }
    await addon.enable();
    await waitFor("trace attached", () => [...doc.querySelectorAll("style")]
      .some(style => style.textContent.includes("data-zotero-blank-drag")));
    const scrollStart = container.scrollTop;
    container.scrollTo({ top: scrollStart + 20, behavior: "instant" });
    report.scrollAPI = { before: scrollStart, afterObject: container.scrollTop };
    container.scrollTo(container.scrollLeft, scrollStart + 40);
    report.scrollAPI.afterNumeric = container.scrollTop;
    container.scrollTop = scrollStart;
    const utils = Components.utils.unwaiveXrays(win).windowUtils;
    const mouse = (type, x, y, clickCount = 1, modifiers = 0, buttons = type === "mouseup" ? 0 : 1) =>
      utils.sendMouseEvent(type, x, y, 0, clickCount, modifiers, false, 0, 0, true, false, buttons);
    const describeNode = node => {
      try { return { tag: node?.localName, id: node?.id, cls: String(node?.className),
        parent: node?.parentNode?.localName, orient: node?.getAttribute?.("orient") }; }
      catch (error) { return { error: String(error) }; }
    };
    report.scrollbarProbe = { events: [], points: [] };
    const traceBar = event => report.scrollbarProbe.events.push({ type: event.type,
      x: event.clientX, y: event.clientY, target: describeNode(event.target),
      original: describeNode(event.originalTarget), explicit: describeNode(event.explicitOriginalTarget) });
    for (const name of ["pointerdown", "mousedown", "pointermove", "wheel"]) win.addEventListener(name, traceBar, true);
    const barRect = container.getBoundingClientRect();
    const barStyle = win.getComputedStyle(container);
    report.scrollbarProbe.geometry = { left: barRect.left, right: barRect.right,
      top: barRect.top, bottom: barRect.bottom, width: barRect.width,
      clientWidth: container.clientWidth, offsetWidth: container.offsetWidth,
      clientLeft: container.clientLeft, height: container.clientHeight,
      scrollbarWidth: barStyle.scrollbarWidth, overflow: barStyle.overflow, direction: barStyle.direction };
    for (const inset of [1, 5, 10, 15, 20]) {
      container.scrollTop = 0;
      await delay(100);
      const x = barRect.right - inset;
      const y = barRect.top + 50;
      mouse("mousemove", x, y, 0, 0, 0);
      mouse("mousedown", x, y);
      const grabbed = doc.documentElement.hasAttribute("data-zotero-blank-drag");
      mouse("mousemove", x, y + 50, 0);
      await delay(100);
      report.scrollbarProbe.points.push({ inset, grabbed, scroll: container.scrollTop });
      mouse("mouseup", x, y + 50);
    }
    check("overlay scrollbar thumb drag stays native at multiple hit positions",
      report.scrollbarProbe.points.slice(0, 3).every(point => !point.grabbed && point.scroll > 0),
      report.scrollbarProbe.points);
    check("content next to overlay scrollbar remains draggable",
      report.scrollbarProbe.points.slice(3).every(point => point.grabbed));
    const barX = barRect.right - 5;
    container.scrollTop = 0;
    await delay(150);
    mouse("mousedown", barX, barRect.bottom - 40);
    const trackDownGrab = doc.documentElement.hasAttribute("data-zotero-blank-drag");
    mouse("mouseup", barX, barRect.bottom - 40);
    await delay(250);
    check("click below scrollbar thumb pages down natively",
      !trackDownGrab && container.scrollTop > 100, container.scrollTop);
    container.scrollTop = container.scrollHeight - container.clientHeight;
    await delay(150);
    const trackBefore = container.scrollTop;
    mouse("mousedown", barX, barRect.top + 40);
    const trackUpGrab = doc.documentElement.hasAttribute("data-zotero-blank-drag");
    mouse("mouseup", barX, barRect.top + 40);
    await delay(250);
    check("click above scrollbar thumb pages up natively",
      !trackUpGrab && container.scrollTop < trackBefore - 100, container.scrollTop);
    const wheel = async (x, y, dy, mode = 1, modifiers = 0) => {
      // Move the actual pointer too; Gecko otherwise retains the preceding wheel
      // transaction's target even when the synthesized wheel coordinates change.
      mouse("mousemove", x, y, 0, 0, 0);
      await delay(150);
      lastWheel = null;
      utils.sendWheelEvent(x, y, 0, dy, 0, mode, modifiers, 0, mode === 1 ? dy : 0, 0);
      await delay(200);
      return { received: !!lastWheel, prevented: lastWheel?.defaultPrevented,
        target: describeNode(lastWheel?.originalTarget), scroll: container.scrollTop,
        kind: lastWheel && api.scrollbarKind(container, lastWheel),
        mode: lastWheel?.deltaMode, dx: lastWheel?.deltaX, dy: lastWheel?.deltaY,
        buttons: lastWheel?.buttons, cancelable: lastWheel?.cancelable,
        contains: lastWheel && container.contains(lastWheel.target) };
    };
    container.scrollTop = 100;
    await delay(150);
    const wheelStart = container.scrollTop;
    const fastDown = await wheel(barX, 80, 3);
    check("wheel on scrollbar advances half a viewport",
      fastDown.received && fastDown.prevented
      && Math.abs(fastDown.scroll - wheelStart - container.clientHeight / 2) <= 1, fastDown);
    const fastUp = await wheel(barX, 80, -3);
    check("wheel on scrollbar reverses half a viewport",
      fastUp.prevented && Math.abs(fastUp.scroll - wheelStart) <= 1, fastUp);
    const pixel = await wheel(barX, 80, 10, 0);
    check("pixel wheel on scrollbar remains proportional",
      pixel.prevented && Math.abs(pixel.scroll - wheelStart - container.clientHeight / 20) <= 1, pixel);
    container.scrollTop = 100;
    await delay(150);
    const trackWheel = await wheel(barX, barRect.bottom - 60, 3);
    check("fast wheel works over empty scrollbar track, not just thumb",
      trackWheel.prevented && Math.abs(trackWheel.scroll - 100 - container.clientHeight / 2) <= 1,
      trackWheel);
    container.scrollTop = 100;
    await delay(150);
    const bodyWheel = await wheel(500, 200, 3);
    check("ordinary page wheel remains native", bodyWheel.received && !bodyWheel.prevented, bodyWheel);
    let zoomReachedNative = false;
    const observeZoom = event => { if (event.ctrlKey) zoomReachedNative = true; };
    win.addEventListener("wheel", observeZoom, false);
    const zoomWheel = await wheel(barX, 80, -3, 1, Components.interfaces.nsIDOMWindowUtils.MODIFIER_CONTROL);
    win.removeEventListener("wheel", observeZoom, false);
    // PDF.js suppresses the actual zoom when document.visibilityState is hidden
    // in headless mode. Verify forwarding to its native window handler instead.
    check("Ctrl wheel on scrollbar reaches native zoom handler",
      zoomReachedNative && zoomWheel.prevented, zoomWheel);
    for (const name of ["pointerdown", "mousedown", "pointermove", "wheel"]) win.removeEventListener(name, traceBar, true);
    container.scrollTop = scrollStart;
    await delay(200);
    blank = atPdfPoint(400, 600);
    text = atPdfPoint((ch[0] + ch[2]) / 2, (ch[1] + ch[3]) / 2);
    const cursorAt = point => win.getComputedStyle(doc.elementFromPoint(point.clientX, point.clientY)).cursor;
    mouse("mousemove", blank.clientX, blank.clientY, 0, 0, 0);
    await delay(150);
    check("blank hover is arrow", cursorAt(blank) === "default", cursorAt(blank));
    let hoverMutations = 0;
    const observer = new (Components.utils.unwaiveXrays(win).MutationObserver)(records => {
      hoverMutations += records.length;
    });
    observer.observe(doc.documentElement, {
      attributes: true, attributeFilter: ["data-zotero-blank-drag-hover"]
    });
    const hoverSamples = [];
    for (let i = 0; i < 30; i++) {
      const point = { clientX: blank.clientX + i, clientY: blank.clientY };
      mouse("mousemove", point.clientX, point.clientY, 0, 0, 0);
      hoverSamples.push(cursorAt(point));
      await delay(20);
      hoverSamples.push(cursorAt(point));
    }
    hoverMutations += observer.takeRecords().length;
    observer.disconnect();
    check("continuous blank hover remains arrow", hoverSamples.every(cursor => cursor === "default"));
    check("continuous blank hover does not toggle override", hoverMutations === 0, hoverMutations);
    mouse("mousemove", text.clientX, text.clientY, 0, 0, 0);
    await delay(150);
    check("text hover keeps text cursor", cursorAt(text) === "text", cursorAt(text));
    const before = container.scrollTop;
    const startupIndex = report.events.length;
    mouse("mousedown", blank.clientX, blank.clientY);
    report.startupSelection = report.events.slice(startupIndex).filter(event => event.type === "mousedown");
    check("blank startup never creates a native text selection",
      report.startupSelection.every(event => !event.nativeAction && event.selectionCount === 0)
      && !view.action && view._selectionRanges.length === 0, report.startupSelection);
    const cursorTools = win.PDFViewerApplication.pdfCursorTools;
    const nativeHand = cursorTools._handTool;
    const pointerDown = report.events.slice(startupIndex).find(event => event.type === "pointerdown");
    check("actual native GrabToPan receives blank mousedown without global tool switch",
      Math.abs(nativeHand.clientXStart - blank.clientX) <= 1 && Math.abs(nativeHand.clientYStart - blank.clientY) <= 1
      && nativeHand.scrollTopStart === before && cursorTools.activeTool === 0
      && view._tool.type === "pointer" && container.classList.contains("grab-to-pan-grab"),
      { start: [nativeHand.clientXStart, nativeHand.clientYStart, nativeHand.scrollTopStart],
        expected: [blank.clientX, blank.clientY, before], activeTool: cursorTools.activeTool,
        tool: view._tool.type, nativeClass: container.classList.contains("grab-to-pan-grab") });
    check("plugin no longer takes pointer capture", !container.hasPointerCapture(pointerDown.pointerId));
    check("blank press immediately shows grabbing", cursorAt(blank) === "grabbing", cursorAt(blank));
    await delay(150);
    check("stationary blank press retains grabbing", cursorAt(blank) === "grabbing", cursorAt(blank));
    mouse("mousemove", blank.clientX + 1, blank.clientY - 1, 0);
    const slightMove = { clientX: blank.clientX + 1, clientY: blank.clientY - 1 };
    check("first pixel scrolls immediately and retains grabbing",
      cursorAt(slightMove) === "grabbing" && container.scrollTop === before + 1);
    check("native GrabToPan creates its own drag overlay",
      nativeHand.overlay.parentNode === doc.body
      && doc.querySelector(".grab-to-pan-grabbing") === nativeHand.overlay);
    mouse("mousemove", blank.clientX, blank.clientY - 65, 0);
    await delay(100);
    const after = container.scrollTop;
    mouse("mouseup", blank.clientX, blank.clientY - 65);
    await delay(100);
    check("real mouse blank drag scrolls", after > before + 30, { before, after });
    check("release clears grabbing", !doc.documentElement.hasAttribute("data-zotero-blank-drag"));
    check("release deactivates native pan and removes overlay without changing selection tool",
      !nativeHand.overlay.parentNode && !container.classList.contains("grab-to-pan-grab")
      && cursorTools.activeTool === 0 && view._tool.type === "pointer");
    const releasedAt = { clientX: blank.clientX, clientY: blank.clientY - 65 };
    check("release over blank restores arrow", cursorAt(releasedAt) === "default", cursorAt(releasedAt));

    container.scrollTop = 0;
    await delay(200);
    const startChar = view._pdfPages[0].chars[0].rect;
    const endChar = view._pdfPages[0].chars[12].rect;
    text = atPdfPoint((startChar[0] + startChar[2]) / 2, (startChar[1] + startChar[3]) / 2);
    const endText = atPdfPoint((endChar[0] + endChar[2]) / 2, (endChar[1] + endChar[3]) / 2);
    mouse("mousedown", text.clientX, text.clientY);
    check("text press retains native selection cursor", cursorAt(text) === "text", cursorAt(text));
    mouse("mousemove", endText.clientX, endText.clientY, 0);
    await delay(100);
    mouse("mouseup", endText.clientX, endText.clientY);
    await delay(100);
    check("real mouse still selects text", view._selectionRanges.some(range => !range.collapsed),
      view._selectionRanges.map(range => ({ text: range.text, collapsed: range.collapsed })));
    const selectionBefore = view._selectionRanges.map(range => range.text).join("");
    for (const name of ["SHIFT", "CONTROL", "ALT", "META"]) {
      container.scrollTop = 0;
      await delay(100);
      blank = atPdfPoint(400, 600);
      const modifier = Components.interfaces.nsIDOMWindowUtils["MODIFIER_" + name];
      if (!Number.isInteger(modifier)) throw new Error("Missing modifier constant: " + name);
      mouse("mousedown", blank.clientX, blank.clientY, 1, modifier);
      mouse("mousemove", blank.clientX, blank.clientY - 40, 0, modifier);
      await delay(100);
      mouse("mouseup", blank.clientX, blank.clientY - 40, 1, modifier);
      check(name + " does not bypass blank drag", container.scrollTop >= 35, container.scrollTop);
      const selectedText = view._selectionRanges.map(range => range.text || "").join("");
      if (selectedText && selectedText !== selectionBefore) throw new Error(name + " extended text selection");
    }
    const selectionAfter = view._selectionRanges.map(range => range.text || "").join("");
    check("modified blank drag does not extend previous text selection",
      selectionAfter === selectionBefore || selectionAfter === "", { selectionBefore, selectionAfter });
    // Compare identical small, continuous and reversing moves with the native tool.
    // These are event-to-scroll checks, not a display/GPU frame-rate benchmark.
    report.motionComparison = {};
    for (const type of ["pointer", "hand"]) {
      view.setTool(Components.utils.cloneInto({ type }, win));
      container.scrollTop = 20;
      await delay(200);
      blank = atPdfPoint(400, 600);
      mouse("mousemove", blank.clientX, blank.clientY, 0, 0, 0);
      const origin = container.scrollTop;
      mouse("mousedown", blank.clientX, blank.clientY);
      const samples = [];
      for (const delta of [1, 2, 3, 4, 5, 12, 30, 29, 28, 12, 1, 0]) {
        mouse("mousemove", blank.clientX, blank.clientY - delta, 0);
        const immediate = container.scrollTop - origin;
        await delay(16);
        samples.push({ delta, immediate, settled: container.scrollTop - origin });
      }
      mouse("mouseup", blank.clientX, blank.clientY);
      report.motionComparison[type] = samples;
    }
    view.setTool(Components.utils.cloneInto({ type: "pointer" }, win));
    check("plugin follows every move immediately including first pixel and reversals",
      report.motionComparison.pointer.every(sample => sample.immediate === sample.delta
        && sample.settled === sample.delta), report.motionComparison.pointer);
    check("plugin scroll response matches native hand tool",
      JSON.stringify(report.motionComparison.pointer) === JSON.stringify(report.motionComparison.hand),
      report.motionComparison);
    await addon.disable();
    check("disable removes plugin styles", ![...doc.querySelectorAll("style")]
      .some(style => style.textContent.includes("data-zotero-blank-drag")));
    await addon.enable();
    await waitFor("re-enable attaches", () => [...doc.querySelectorAll("style")]
      .some(style => style.textContent.includes("data-zotero-blank-drag")));
    check("re-enable attaches to open PDF", true);
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = String(error) + "\n" + error.stack;
    report.zoteroErrors = Zotero.getErrors?.(true);
  } finally {
    await save();
    Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);
  }
}
