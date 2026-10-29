const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function load() {
  const listeners = new Map();
  const timers = new Map();
  const errors = [];
  const Zotero = {
    Reader: {
      _readers: [],
      registerEventListener: (name, fn) => listeners.set(name, fn),
      unregisterEventListener: name => listeners.delete(name)
    },
    logError: error => errors.push(error)
  };
  const context = vm.createContext({
    Zotero,
    setInterval: callback => { timers.set(1, callback); return 1; },
    clearInterval: id => timers.delete(id)
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../content/blank-drag.js'), 'utf8'), context);
  return { api: context.BlankDrag, Zotero, listeners, timers, errors };
}

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, callback) {
    const list = this.listeners.get(type) || [];
    list.push(callback);
    this.listeners.set(type, list);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(fn => fn !== callback));
  }
  emit(type, event = {}) {
    event.type = type;
    event.preventDefault = () => { event.defaultPrevented = true; };
    event.stopImmediatePropagation = () => { event.stopped = true; };
    for (const fn of [...(this.listeners.get(type) || [])]) {
      fn(event);
      if (event.stopped) break;
    }
    // Model the browser's separate compatibility mousemove dispatch. Production
    // pan tests below now rely on native mousemove, not pointermove scroll writes.
    if (type === 'pointermove') this.emit('mousemove', { ...event,
      pointerType: undefined, stopped: false, defaultPrevented: false });
    return event;
  }
  count() { return [...this.listeners.values()].reduce((n, list) => n + list.length, 0); }
}

function fixture() {
  const win = new Target();
  const doc = new Target();
  const root = {
    attrs: new Set(),
    hasAttribute(name) { return this.attrs.has(name); },
    setAttribute(name) { this.attrs.add(name); },
    removeAttribute(name) { this.attrs.delete(name); },
    appendChild() {}
  };
  const container = Object.assign(new Target(), {
    scrollLeft: 200, scrollTop: 300, clientLeft: 0, clientTop: 0,
    clientWidth: 800, clientHeight: 600,
    scrollHeight: 3000,
    contains: target => target === container || target?.inside,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
    scrollTo(left, top) {
      assert.equal(typeof left, 'number', 'cross-compartment scroll uses numeric overload');
      assert.equal(typeof top, 'number');
      this.scrollLeft = left; this.scrollTop = top;
    },
    setPointerCapture(id) { this.capture = id; },
    hasPointerCapture(id) { return this.capture === id; },
    releasePointerCapture() { this.capture = null; }
  });
  doc.documentElement = root;
  doc.createElement = () => ({ remove() { this.removed = true; } });
  doc.getElementById = () => container;
  win.document = doc;
  win.PDFViewerApplication = { pdfViewer: { _pages: [{ viewport: { scale: 1 } }] } };
  // Test double for the native reader component, not an alternative plugin pan.
  // The real GrabToPan instance is verified by the Zotero integration harness.
  const hand = {
    active: false, moving: false,
    activate() {
      if (this.active) return;
      this.active = true;
      win.addEventListener('mousedown', nativeDown);
    },
    deactivate() {
      this.active = false; this.moving = false;
      win.removeEventListener('mousedown', nativeDown);
      win.removeEventListener('mousemove', nativeMove);
    }
  };
  const nativeDown = event => {
    if (!hand.active) return;
    hand.x = event.clientX; hand.y = event.clientY;
    hand.left = container.scrollLeft; hand.top = container.scrollTop;
    hand.moving = true;
    win.addEventListener('mousemove', nativeMove);
    event.preventDefault(); event.stopImmediatePropagation();
  };
  const nativeMove = event => {
    if (hand.moving && event.buttons & 1) {
      container.scrollTo(hand.left - (event.clientX - hand.x), hand.top - (event.clientY - hand.y));
    }
  };
  win.PDFViewerApplication.pdfCursorTools = { activeTool: 0, _handTool: hand };
  const view = {
    _iframeWindow: win, _iframe: { isConnected: true }, _tool: { type: 'pointer' },
    _pdfPages: { 0: { chars: [{ rect: [100, 100, 200, 120] }] } },
    _autoScroll: {},
    pointerEventToPosition: event => ({ pageIndex: 0, rects: [[event.clientX, event.clientY, event.clientX, event.clientY]] }),
    _getSelectableOverlay: () => null,
    getActionAtPosition: () => ({ action: { type: 'selectText' }, selectAnnotations: [] }),
    _clearPointerAction() { this.action = null; this.cleared = true; }
  };
  const target = {
    nodeType: 1, inside: true,
    closest: selector => selector === '.page' ? {} : null
  };
  doc.elementFromPoint = () => target;
  const event = extra => ({
    pointerType: 'mouse', pointerId: 7, button: 0, buttons: 1,
    clientX: 300, clientY: 300, detail: 1, target, ...extra
  });
  return { view, container, win, doc, root, target, event };
}

test('blank page allows pan; text and a small glyph-edge margin preserve selection', () => {
  const { api } = load();
  const f = fixture();
  assert.equal(api.canStart(f.view, f.container, f.event()), true);
  for (const [clientX, clientY] of [[150, 110], [99, 110], [201, 121]]) {
    assert.equal(api.canStart(f.view, f.container, f.event({ clientX, clientY })), false);
  }
  f.view._iframeWindow.PDFViewerApplication.pdfViewer._pages[0].viewport.scale = 4;
  assert.equal(api.canStart(f.view, f.container, f.event({ clientX: 99, clientY: 110 })), true);
});

function nativeBar(f, axis = 'vertical', name = 'thumb') {
  const bar = { localName: 'scrollbar', parentNode: f.container,
    getAttribute: key => key === 'orient' ? axis : null };
  return { localName: name, parentNode: bar, getAttribute: () => null };
}

test('overlay scrollbar parts never start pan, including retargeted events and modifiers', () => {
  const { api } = load();
  for (const axis of ['vertical', 'horizontal']) {
    for (const name of ['thumb', 'slider', 'scrollbarbutton']) {
      const f = fixture();
      const c = new api.Controller(f.view, error => { throw error; });
      const originalTarget = nativeBar(f, axis, name);
      // clientWidth includes an overlay bar. The DOM target is ordinary content.
      for (const extra of [{}, { shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
        const e = f.event({ clientX: 795, originalTarget, ...extra });
        assert.equal(api.scrollbarKind(f.container, e), axis);
        assert.equal(api.canStart(f.view, f.container, e), false);
        f.win.emit('pointermove', { ...e, buttons: 0 });
        assert.equal(f.root.attrs.size, 0);
        assert.notEqual(f.win.emit('pointerdown', { ...e }).defaultPrevented, true);
        assert.notEqual(f.win.emit('mousedown', { ...e, pointerType: undefined }).defaultPrevented, true);
        assert.equal(c.drag, null);
        assert.equal(c.nativeHand, null);
        assert.equal(f.container.capture, undefined);
        assert.equal(f.root.attrs.size, 0);
      }
      c.destroy();
    }
  }
});

test('classic right/left/bottom bars and corner are excluded, without reserving a content strip', () => {
  const { api } = load();
  const f = fixture();
  f.container.getBoundingClientRect = () => ({ left: 10, top: 20, right: 825, bottom: 635 });
  for (const [x, y, kind] of [[815, 300, 'vertical'], [300, 625, 'horizontal'], [815, 625, 'corner']]) {
    assert.equal(api.scrollbarKind(f.container, f.event({ clientX: x, clientY: y })), kind);
    assert.equal(api.canStart(f.view, f.container, f.event({ clientX: x, clientY: y })), false);
  }
  f.container.clientLeft = 15;
  assert.equal(api.scrollbarKind(f.container, f.event({ clientX: 15 })), 'vertical');
  assert.equal(api.scrollbarKind(f.container, f.event({ clientX: 820 })), null);
  const g = fixture();
  assert.equal(api.canStart(g.view, g.container, g.event({ clientX: 799 })), true,
    'content at the edge remains draggable when no scrollbar is hit');
});

test('inaccessible native target fails closed and scrollbar mousedown cancels active drag', () => {
  const { api } = load();
  const f = fixture();
  const e = f.event();
  Object.defineProperty(e, 'originalTarget', { get() { throw new Error('inaccessible native node'); } });
  assert.equal(api.canStart(f.view, f.container, e), false);
  const c = new api.Controller(f.view, error => { throw error; });
  f.win.emit('pointerdown', f.event());
  assert.ok(c.drag);
  const down = f.win.emit('mousedown', f.event({ originalTarget: nativeBar(f) }));
  assert.notEqual(down.defaultPrevented, true);
  assert.equal(c.drag, null);
  assert.equal(c.nativeHand, null);
  assert.equal(f.root.attrs.size, 0);
  c.destroy();
});

test('vertical scrollbar wheel advances half viewport, preserves horizontal offset and clamps', () => {
  const { api } = load();
  const f = fixture();
  const c = new api.Controller(f.view, error => { throw error; });
  const wheel = extra => f.container.emit('wheel', f.event({ buttons: 0,
    originalTarget: nativeBar(f), deltaMode: 1, deltaX: 0, deltaY: 3, ...extra }));
  assert.equal(wheel().defaultPrevented, true);
  assert.equal(f.container.scrollTop, 600);
  assert.equal(f.container.scrollLeft, 200);
  wheel({ deltaY: -3 });
  assert.equal(f.container.scrollTop, 300);
  wheel({ deltaMode: 0, deltaY: 10 });
  assert.equal(f.container.scrollTop, 330, 'pixel input scales proportionally');
  f.container.scrollTop = 2390;
  wheel();
  assert.equal(f.container.scrollTop, 2400);
  f.container.scrollTop = 1;
  wheel({ deltaY: -3 });
  assert.equal(f.container.scrollTop, 0);
  c.destroy();
  assert.notEqual(wheel().defaultPrevented, true, 'disable removes fast wheel listener');
});

test('body wheel, other axes, modifiers, page input, pressed buttons and active pan stay native', () => {
  const { api } = load();
  const f = fixture();
  const c = new api.Controller(f.view, error => { throw error; });
  for (const extra of [
    { originalTarget: f.target }, { originalTarget: nativeBar(f, 'horizontal') },
    { originalTarget: { localName: 'scrollcorner' } },
    { target: { inside: false } }, { ctrlKey: true }, { shiftKey: true },
    { metaKey: true }, { altKey: true }, { buttons: 1 }, { buttons: 2 },
    { deltaMode: 2 }, { deltaX: 1 }, { deltaY: 0 }, { deltaY: NaN }, { cancelable: false }
  ]) {
    const e = f.container.emit('wheel', f.event({ buttons: 0, deltaMode: 1, deltaX: 0,
      deltaY: 3, originalTarget: nativeBar(f), ...extra }));
    assert.notEqual(e.defaultPrevented, true);
    assert.equal(f.container.scrollTop, 300);
  }
  f.win.emit('pointerdown', f.event());
  f.win.emit('mousedown', f.event());
  assert.ok(c.drag);
  const e = f.container.emit('wheel', f.event({ buttons: 0, deltaMode: 1, deltaY: 3,
    originalTarget: nativeBar(f) }));
  assert.notEqual(e.defaultPrevented, true);
  assert.equal(f.container.scrollTop, 300);
  c.destroy();
});

test('links, annotations, selected-text drags, resize handles, controls and scrollbars remain native', () => {
  const { api } = load();
  for (const type of ['drag', 'moveAndDrag', 'resize', 'rotate', 'updateAnnotationRange']) {
    const f = fixture();
    f.view.getActionAtPosition = () => ({ action: { type } });
    assert.equal(api.canStart(f.view, f.container, f.event()), false, type);
  }
  const f = fixture();
  f.view._getSelectableOverlay = () => ({ type: 'external-link' });
  assert.equal(api.canStart(f.view, f.container, f.event()), false);
  f.view._getSelectableOverlay = () => null;
  f.target.closest = () => ({});
  assert.equal(api.canStart(f.view, f.container, f.event()), false);
  f.target.closest = () => null;
  assert.equal(api.canStart(f.view, f.container, f.event({ clientX: 800 })), false);
  f.target.inside = false;
  assert.equal(api.canStart(f.view, f.container, f.event()), false);
});

test('double/triple-click, non-left buttons, touch, pen and annotation tools bypass', () => {
  const { api } = load();
  const f = fixture();
  for (const extra of [
    { button: 1 }, { button: 2 }, { detail: 2 }, { detail: 3 },
    { pointerType: 'touch' }, { pointerType: 'pen' }, { isPrimary: false }
  ]) assert.equal(api.canStart(f.view, f.container, f.event(extra)), false, JSON.stringify(extra));
  for (const type of ['hand', 'highlight', 'underline', 'note', 'image', 'text', 'ink', 'eraser']) {
    f.view._tool.type = type;
    assert.equal(api.canStart(f.view, f.container, f.event()), false, type);
  }
});

test('all modifiers allow blank dragging without starting native modified selection', () => {
  const { api } = load();
  for (const key of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey']) {
    const f = fixture();
    const c = new api.Controller(f.view, error => { throw error; });
    assert.equal(api.canStart(f.view, f.container, f.event({ [key]: true })), true);
    assert.equal(api.canStart(f.view, f.container,
      f.event({ [key]: true, clientX: 150, clientY: 110 })), false);
    const down = f.win.emit('pointerdown', f.event({ [key]: true }));
    assert.notEqual(down.defaultPrevented, true, 'preserve mousedown for native GrabToPan');
    f.view.action = { type: 'selectText' };
    f.win.emit('mousedown', f.event({ [key]: true, pointerType: undefined }));
    assert.equal(f.view.action, null, 'compatibility mousedown cannot start native selection');
    f.win.emit('pointermove', f.event({ [key]: true, clientY: 250 }));
    assert.equal(f.container.scrollTop, 350);
    c.destroy();
  }
});

test('hover arrow is limited to blank space and clears on text, tools, leave and destroy', () => {
  const { api } = load();
  const f = fixture();
  const c = new api.Controller(f.view, error => { throw error; });
  const hover = extra => f.win.emit('pointermove', f.event({ button: -1, buttons: 0, detail: 0, ...extra }));
  const active = () => f.root.attrs.has('data-zotero-blank-drag-hover');
  hover();
  assert.equal(active(), true);
  hover({ clientX: 150, clientY: 110 });
  assert.equal(active(), false);
  hover({ shiftKey: true });
  assert.equal(active(), true);
  f.view.getSelectableAnnotations = () => [{}];
  hover({ altKey: true });
  assert.equal(active(), false);
  f.view.getSelectableAnnotations = () => [];
  f.view.getSelectedAnnotations = () => [{}];
  f.view.getSelectedAnnotationAction = () => ({ type: 'resize' });
  hover({ altKey: true });
  assert.equal(active(), false);
  f.view.getSelectedAnnotations = () => [];
  f.view._tool.type = 'ink';
  hover();
  assert.equal(active(), false);
  f.view._tool.type = 'pointer';
  hover();
  f.container.emit('pointerleave');
  assert.equal(active(), false);
  hover();
  c.destroy();
  assert.equal(active(), false);
});

test('unloaded pages fail closed, scanned pages and gray gaps allow pan', () => {
  const { api } = load();
  const f = fixture();
  f.view._pdfPages = {};
  assert.equal(api.canStart(f.view, f.container, f.event()), false);
  f.view._pdfPages = { 0: { chars: [] } };
  assert.equal(api.canStart(f.view, f.container, f.event()), true);
  f.view.pointerEventToPosition = () => null;
  assert.equal(api.canStart(f.view, f.container, f.event()), false);
  f.target.closest = () => null;
  assert.equal(api.canStart(f.view, f.container, f.event()), true);
});

test('continuous blank hover keeps the arrow during layout reads without attribute churn', () => {
  const { api } = load();
  const f = fixture();
  const c = new api.Controller(f.view, error => { throw error; });
  const move = x => f.win.emit('pointermove', f.event({ clientX: x, buttons: 0, button: -1, detail: 0 }));
  move(300);
  let mutations = 0;
  const originalSet = f.root.setAttribute.bind(f.root);
  const originalRemove = f.root.removeAttribute.bind(f.root);
  f.root.setAttribute = name => { mutations++; originalSet(name); };
  f.root.removeAttribute = name => { mutations++; originalRemove(name); };
  const originalHitTest = f.view.pointerEventToPosition;
  f.view.pointerEventToPosition = event => {
    assert.equal(f.root.hasAttribute('data-zotero-blank-drag-hover'), true,
      'arrow must remain applied while hit testing forces layout');
    return originalHitTest(event);
  };
  for (let i = 0; i < 100; i++) move(300 + i);
  f.doc.emit('scroll');
  assert.equal(mutations, 0, 'remaining in blank space should not toggle styles');
  f.view.pointerEventToPosition = originalHitTest;
  c.destroy();
});

function begin(api, f) {
  const c = new api.Controller(f.view, error => { throw error; });
  f.win.emit('pointerdown', f.event());
  f.view.action = { type: 'selectText' }; // Native mousedown runs first.
  f.win.emit('mousedown', f.event({ pointerType: undefined }));
  return c;
}

test('blank pointerdown bypasses native selection before compatibility mousedown without rendering', () => {
  const { api } = load();
  const f = fixture();
  let nativeStarts = 0;
  let renders = 0;
  f.view._render = () => { renders++; };
  f.win.addEventListener('mousedown', () => {
    if (f.view._pointerDownTriggered) return;
    nativeStarts++;
  });
  const c = new api.Controller(f.view, error => { throw error; });
  const down = f.win.emit('pointerdown', f.event());
  assert.notEqual(down.defaultPrevented, true, 'native GrabToPan needs compatibility mousedown');
  assert.equal(f.view._pointerDownTriggered, true);
  f.win.emit('mousedown', f.event({ pointerType: undefined }));
  assert.equal(nativeStarts, 0);
  assert.equal(renders, 0);
  assert.ok(!c.style.textContent.includes('user-select'), 'no document-wide selection style invalidation');
  f.win.emit('pointerup', f.event({ buttons: 0 }));
  assert.equal(f.view._pointerDownTriggered, false);
  f.win.emit('pointerdown', f.event({ clientX: 150, clientY: 110 }));
  f.win.emit('mousedown', f.event({ clientX: 150, clientY: 110 }));
  assert.equal(nativeStarts, 1, 'text down still reaches native selection');
  c.destroy();
});

test('blank down clears existing text and annotation selection once, without repeated renders', () => {
  const { api } = load();
  const f = fixture();
  let clears = 0;
  let renders = 0;
  f.view._selectionRanges = [{ collapsed: false }];
  f.view._selectedAnnotationIDs = ['selected'];
  f.view.clearSelection = () => { clears++; f.view._selectionRanges = []; };
  f.view._onSelectAnnotations = ids => { f.view._selectedAnnotationIDs = ids; };
  f.view._render = () => { renders++; };
  const c = begin(api, f);
  assert.equal(clears, 1);
  assert.equal(renders, 1);
  assert.equal(f.view._selectedAnnotationIDs.length, 0);
  f.win.emit('pointermove', f.event({ clientY: 299 }));
  assert.equal(renders, 1);
  c.destroy();
  assert.equal(f.view._pointerDownTriggered, false);
});

test('native one-pixel pan, two-axis direction, no plugin pointer capture, release and click suppression', () => {
  const { api } = load();
  const f = fixture();
  const c = begin(api, f);
  assert.equal(f.view.cleared, true);
  assert.equal(f.container.capture, undefined);
  assert.equal(f.win.PDFViewerApplication.pdfCursorTools._handTool.moving, true);
  assert.equal(f.root.hasAttribute('data-zotero-blank-drag'), true, 'grabbing starts before movement');
  f.win.emit('pointermove', f.event({ clientX: 301, clientY: 301 }));
  assert.equal(f.container.scrollTop, 299);
  assert.equal(f.container.scrollLeft, 199);
  assert.equal(f.root.hasAttribute('data-zotero-blank-drag'), true, 'small movements retain grabbing');
  f.win.emit('pointermove', f.event({ clientX: 330, clientY: 250 }));
  assert.equal(f.container.scrollLeft, 170);
  assert.equal(f.container.scrollTop, 350);
  assert.equal(f.root.attrs.size, 1);
  f.win.emit('pointerup', f.event({ buttons: 0 }));
  assert.equal(c.drag, null);
  assert.equal(f.container.capture, undefined);
  assert.equal(f.win.PDFViewerApplication.pdfCursorTools._handTool.active, false);
  assert.equal(f.root.attrs.has('data-zotero-blank-drag'), false);
  assert.equal(f.root.attrs.has('data-zotero-blank-drag-hover'), true);
  f.container.emit('lostpointercapture');
  assert.equal(f.root.attrs.has('data-zotero-blank-drag-hover'), true);
  assert.equal(f.win.emit('click', f.event()).defaultPrevented, true);
  c.destroy();
  assert.equal(f.win.count() + f.container.count() + f.doc.count(), 0);
  assert.equal(c.style.removed, true);
});

test('every drag event scrolls synchronously, including reversal, without layout or hit tests', () => {
  const { api } = load();
  const f = fixture();
  const c = begin(api, f);
  const unexpected = () => { throw new Error('drag hot path must not hit-test or mutate cursor styles'); };
  const hitTest = f.view.pointerEventToPosition;
  const bounds = f.container.getBoundingClientRect;
  const set = f.root.setAttribute;
  const remove = f.root.removeAttribute;
  f.view.pointerEventToPosition = unexpected;
  f.container.getBoundingClientRect = unexpected;
  f.doc.elementFromPoint = unexpected;
  f.root.setAttribute = unexpected;
  f.root.removeAttribute = unexpected;
  let writes = 0;
  const scroll = f.container.scrollTo;
  f.container.scrollTo = function(left, top) { writes++; scroll.call(this, left, top); };
  for (let i = 1; i <= 1200; i++) {
    const dx = (i % 41) - 20;
    const dy = (i % 61) - 30;
    f.win.emit('pointermove', f.event({ clientX: 300 + dx, clientY: 300 + dy }));
    f.doc.emit('scroll');
    assert.equal(f.container.scrollLeft, 200 - dx);
    assert.equal(f.container.scrollTop, 300 - dy);
    assert.equal(writes, i, 'no deferred/coalesced scroll updates');
  }
  f.win.emit('pointermove', f.event());
  assert.equal(f.container.scrollLeft, 200, 'return to starting position');
  assert.equal(f.container.scrollTop, 300);
  f.view.pointerEventToPosition = hitTest;
  f.container.getBoundingClientRect = bounds;
  f.root.setAttribute = set;
  f.root.removeAttribute = remove;
  c.destroy();
});

test('blank press and release retain cursor override during hit testing, even without a drag', () => {
  const { api } = load();
  const f = fixture();
  const c = new api.Controller(f.view, error => { throw error; });
  f.win.emit('pointermove', f.event({ buttons: 0, button: -1 }));
  const hitTest = f.view.pointerEventToPosition;
  f.view.pointerEventToPosition = event => {
    assert.ok(f.root.hasAttribute('data-zotero-blank-drag-hover')
      || f.root.hasAttribute('data-zotero-blank-drag'), 'layout reads never expose native I-beam');
    return hitTest(event);
  };
  f.win.emit('pointerdown', f.event());
  assert.equal(f.root.hasAttribute('data-zotero-blank-drag'), true);
  f.view.action = { type: 'selectText' };
  f.win.emit('mousedown', f.event({ pointerType: undefined }));
  assert.equal(f.root.hasAttribute('data-zotero-blank-drag'), true);
  f.win.emit('pointerup', f.event({ buttons: 0 }));
  assert.equal(f.root.hasAttribute('data-zotero-blank-drag'), false);
  assert.equal(f.root.hasAttribute('data-zotero-blank-drag-hover'), true);
  assert.equal(f.container.scrollTop, 300);
  c.destroy();
});

test('ordinary blank click is not swallowed and text-start gestures are never taken over', () => {
  const { api } = load();
  const f = fixture();
  const c = begin(api, f);
  f.win.emit('pointerup', f.event({ buttons: 0 }));
  assert.notEqual(f.win.emit('click', f.event()).defaultPrevented, true);
  f.win.emit('pointerdown', f.event({ clientX: 150, clientY: 110 }));
  f.win.emit('mousedown', f.event({ pointerType: undefined, clientX: 150, clientY: 110 }));
  assert.equal(c.drag, null);
  assert.notEqual(f.win.emit('pointermove', f.event()).stopped, true);
});

test('blur, Escape, cancel, lost button and tool changes terminate native dragging', () => {
  const { api } = load();
  for (const kind of ['blur', 'Escape', 'pointercancel', 'lostbutton', 'tool']) {
    const f = fixture();
    const c = begin(api, f);
    f.win.emit('pointermove', f.event({ clientY: 250 }));
    if (kind === 'lostpointercapture') f.container.emit(kind);
    else if (kind === 'Escape') f.win.emit('keydown', { key: 'Escape' });
    else if (kind === 'lostbutton') f.win.emit('pointermove', f.event({ buttons: 0 }));
    else if (kind === 'tool') {
      f.view._tool.type = 'ink';
      f.win.emit('pointermove', f.event());
    } else f.win.emit(kind);
    assert.equal(c.drag, null, kind);
    assert.equal(f.win.PDFViewerApplication.pdfCursorTools._handTool.active, false, kind);
    assert.equal(f.root.attrs.size, 0, kind);
  }
});

test('existing readers, split views, close, disable and re-enable clean up all resources', () => {
  const { api, Zotero, timers, errors } = load();
  const a = fixture();
  const b = fixture();
  const internal = { _type: 'pdf', _primaryView: a.view };
  Zotero.Reader._readers.push({ _internalReader: internal });
  api.start();
  const count = a.win.count();
  assert.ok(count > 0);
  api.start();
  assert.equal(a.win.count(), count);
  internal._secondaryView = b.view;
  timers.get(1)();
  assert.equal(b.win.count(), count);
  internal._secondaryView = null;
  timers.get(1)();
  assert.equal(b.win.count(), 0);
  api.stop();
  assert.equal(a.win.count(), 0);
  assert.equal(timers.size, 0);
  api.start();
  assert.equal(a.win.count(), count);
  Zotero.Reader._readers.length = 0;
  timers.get(1)();
  assert.equal(a.win.count(), 0);
  api.stop();
  assert.equal(errors.length, 0);
});

test('native hand owns motion and global hand choice survives cleanup', () => {
  const { api } = load();
  const f = fixture();
  const c = begin(api, f);
  const tools = f.win.PDFViewerApplication.pdfCursorTools;
  // Calling only the plugin handler must never write the scroll position.
  c.onMove({ ...f.event({ clientY: 250 }), stopImmediatePropagation() {} });
  assert.equal(f.container.scrollTop, 300);
  f.win.emit('mousemove', f.event({ clientY: 250 }));
  assert.equal(f.container.scrollTop, 350, 'native mousemove performs the pan');
  tools.activeTool = 1;
  f.view._tool.type = 'hand';
  c.destroy();
  assert.equal(tools._handTool.active, true, 'preserve newly selected global hand');
  assert.equal(tools._handTool.moving, false, 'end old gesture');
  assert.equal(f.view._pointerDownTriggered, false);
  tools._handTool.deactivate();
});

test('missing native hand support fails closed instead of falling back to custom dragging', () => {
  const { api } = load();
  const f = fixture();
  const c = new api.Controller(f.view, error => { throw error; });
  f.win.PDFViewerApplication.pdfCursorTools._handTool = null;
  const down = f.win.emit('pointerdown', f.event());
  assert.equal(c.drag, null);
  assert.equal(f.root.attrs.size, 0);
  assert.notEqual(down.defaultPrevented, true);
  c.destroy();
});
