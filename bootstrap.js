/* global Zotero, Services, setInterval, clearInterval */
"use strict";

var blankDragScope;

async function startup({ rootURI }) {
  await Zotero.initializationPromise;
  blankDragScope = { Zotero, setInterval, clearInterval };
  Services.scriptloader.loadSubScript(rootURI + "content/blank-drag.js", blankDragScope);
  blankDragScope.BlankDrag.start();
}

function shutdown() {
  blankDragScope?.BlankDrag.stop();
  blankDragScope = null;
}

function install() {}
function uninstall() {}
