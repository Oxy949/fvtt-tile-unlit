import assert from "node:assert/strict";

class Point {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  copyFrom(other) {
    this.x = other.x;
    this.y = other.y;
  }

  set(x, y = x) {
    this.x = x;
    this.y = y;
  }
}

class Container {
  constructor() {
    this.children = [];
    this.parent = null;
    this.destroyed = false;
    this.visible = true;
    this.renderable = true;
    this.alpha = 1;
    this.zIndex = 0;
    this.filters = null;
  }

  addChild(...children) {
    for (const child of children) this.addChildAt(child, this.children.length);
    return children[0];
  }

  addChildAt(child, index) {
    child.parent?.removeChild(child);
    child.parent = this;
    this.children.splice(Math.max(0, Math.min(index, this.children.length)), 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    if (child.parent === this) child.parent = null;
    return child;
  }

  getChildIndex(child) {
    return this.children.indexOf(child);
  }

  render(renderer) {
    if (!this.visible || !this.renderable || this.destroyed) return;
    this._render?.(renderer);
    for (const child of [...this.children]) child.render?.(renderer);
  }

  destroy(options = {}) {
    this.parent?.removeChild(this);
    if (options.children) {
      for (const child of [...this.children]) child.destroy?.(options);
    }
    this.children.length = 0;
    this.destroyed = true;
  }
}

class Sprite extends Container {
  constructor(texture = null) {
    super();
    this.texture = texture;
    this.position = new Point();
    this.scale = new Point(1, 1);
    this.pivot = new Point();
    this.skew = new Point();
    this.anchor = new Point(0.5, 0.5);
    this.rotation = 0;
    this.tint = 0xFFFFFF;
    this.blendMode = 0;
  }
}

class AlphaFilter {
  constructor(alpha = 1) {
    this.alpha = alpha;
    this.destroyed = false;
  }

  destroy() {
    this.destroyed = true;
  }
}

const hookCallbacks = new Map();
globalThis.Hooks = {
  on(name, callback) {
    const callbacks = hookCallbacks.get(name) ?? [];
    callbacks.push(callback);
    hookCallbacks.set(name, callbacks);
  },
  once(name, callback) {
    this.on(name, callback);
  }
};

const callHook = (name, ...args) => {
  for (const callback of hookCallbacks.get(name) ?? []) callback(...args);
};

const tickerCallbacks = [];
const ticker = {
  add(callback, context, priority = 0) {
    tickerCallbacks.push({ callback, context, priority });
  },
  remove(callback, context) {
    for (let index = tickerCallbacks.length - 1; index >= 0; index--) {
      const item = tickerCallbacks[index];
      if (item.callback === callback && (!context || item.context === context)) tickerCallbacks.splice(index, 1);
    }
  }
};

const runTicker = () => {
  for (const item of [...tickerCallbacks].sort((a, b) => b.priority - a.priority)) {
    item.callback.call(item.context);
  }
};

globalThis.PIXI = {
  Container,
  Sprite,
  AlphaFilter,
  filters: { AlphaFilter },
  UPDATE_PRIORITY: { LOW: -25 }
};
globalThis.requestAnimationFrame = callback => callback();
globalThis.jQuery = class JQuery {};

const rendered = new Container();
const effects = new Container();
const visibility = new Container();
const interfaceGroup = new Container();
rendered.addChild(effects, visibility, interfaceGroup);

const flags = {
  "fvtt-tile-unlit": { ignoreLighting: 1, ignoreWeather: false },
  "darkness-activated-tiles": { darkness: { enabled: true } }
};
const document = {
  id: "tile-1",
  documentName: "Tile",
  alpha: 1,
  elevation: 0,
  sort: 0,
  getFlag(moduleId, key) {
    return key.split(".").reduce((value, part) => value?.[part], flags[moduleId]);
  }
};
const mesh = new Sprite({ id: "tile-texture" });
mesh.alpha = 1;
mesh.unoccludedAlpha = 1;
const tile = {
  id: document.id,
  document,
  mesh,
  isVisible: true,
  sourceId: "Scene.test.Tile.tile-1",
  renderFlags: { set() {} }
};
document.object = tile;

const moduleStates = new Map([
  ["fxmaster", { active: false }],
  ["darkness-activated-tiles", { active: true }]
]);
const settings = new Map([
  ["fxmaster.enable", true],
  ["fxmaster.disableAll", false],
  ["fxmaster.displayEffectsOverVision", false]
]);

let coreWeatherRenders = 0;
globalThis.game = {
  modules: { get: id => moduleStates.get(id) },
  settings: { get: (moduleId, key) => settings.get(`${moduleId}.${key}`) }
};
globalThis.canvas = {
  ready: true,
  effects,
  visibility,
  rendered,
  environment: rendered,
  interface: interfaceGroup,
  app: { ticker, renderer: { screen: {} } },
  tiles: {
    placeables: [tile],
    get: id => id === tile.id ? tile : null,
    preview: { children: [] }
  },
  weather: { destroyed: false, render: () => coreWeatherRenders++ }
};
globalThis.CONFIG = {};
globalThis.FXMASTER = null;
globalThis.foundry = { applications: { handlebars: {} } };

await import(new URL("../scripts/tile-unlit.js", import.meta.url));
callHook("canvasReady");

const affectedRoot = rendered.children.find(child => child.name === "fvtt-tile-unlit.unlitPass");
const ignoredRoot = rendered.children.find(child => child.name === "fvtt-tile-unlit.weatherIgnoredPass");
const affected = affectedRoot.children.find(child => child.name === "fvtt-tile-unlit.weatherAffected");
const ignored = ignoredRoot.children.find(child => child.name === "fvtt-tile-unlit.weatherIgnored");
const unlitSprite = affected.children.find(child => child.name === "fvtt-tile-unlit.tile-1");

assert.ok(affectedRoot && ignoredRoot && unlitSprite, "canvasReady creates both unlit passes");
assert.equal(mesh.renderable, true, "the source mesh remains renderable for third-party mask inspection");
assert.equal(mesh.filters.length, 1, "the fully unlit source mesh is suppressed by a filter");
assert.equal(mesh.filters[0].alpha, 0, "the source suppression filter is transparent");

flags["fvtt-tile-unlit"].ignoreLighting = 0.5;
callHook("updateTile", document);
assert.equal(mesh.filters, null, "partial strength restores the normally-lit source mesh");
flags["fvtt-tile-unlit"].ignoreLighting = 1;
callHook("updateTile", document);
assert.equal(mesh.filters.length, 1, "full strength reuses transparent source suppression");

mesh.alpha = 0.35;
callHook("lightingRefresh");
runTicker();
assert.equal(unlitSprite.alpha, 0.35, "Darkness Activated Tiles live fade alpha is mirrored");

moduleStates.get("fxmaster").active = true;
callHook("clientSettingChanged");
const fxFilterTop = { enabled: true, destroyed: false };
const fxFilterBottom = { enabled: true, destroyed: false };
const filterEntries = new Map([
  ["filter-top", { filter: fxFilterTop }],
  ["filter-bottom", { filter: fxFilterBottom }]
]);
globalThis.FXMASTER = {
  filters: {
    stackEntries: filterEntries,
    getStackFilter: uid => filterEntries.get(uid)?.filter ?? null
  }
};

let particleRenders = 0;
const particleRoot = new Container();
const particleSlot = new Container();
particleSlot._render = () => particleRenders++;
particleRoot.addChild(particleSlot);
const particleEntry = { root: particleRoot, slot: particleSlot, fx: { enabled: true }, container: particleSlot };
canvas.particleeffects = {
  stackEntries: new Map([["particle-1", particleEntry]]),
  _stackRoots: new Map([[particleRoot, new Set([particleSlot])]])
};
const compositor = {
  _stackRowsFrame: [
    { uid: "filter-top", kind: "filter" },
    { uid: "filter-bottom", kind: "filter" }
  ],
  _displayContainer: null
};
CONFIG.fxmaster = { getGlobalEffectsCompositor: () => compositor };

runTicker();
assert.deepEqual(
  affectedRoot.filters,
  [fxFilterBottom, fxFilterTop],
  "FXMaster filters are applied to the affected pass in compositor order"
);

const overlay = affectedRoot.children.find(child => child.name === "fvtt-tile-unlit.weatherOverlay");
const weatherReplay = overlay.children[0].children[0];
weatherReplay.render({});
assert.equal(coreWeatherRenders, 1, "core weather is replayed through the tile mask");
assert.equal(particleRenders, 1, "FXMaster particles are replayed through the tile mask");

flags["fvtt-tile-unlit"].ignoreWeather = true;
callHook("updateTile", document);
runTicker();
assert.equal(unlitSprite.parent, ignored, "Ignore Weather moves the sprite to the isolated pass");

settings.set("fxmaster.displayEffectsOverVision", true);
callHook("updateSetting");
const fxOutput = new Container();
fxOutput.name = "fxmasterGlobalEffectsOutputContainer";
const fxOutputSprite = new Sprite();
fxOutputSprite.name = "fxmasterGlobalEffectsOutput";
fxOutput.addChild(fxOutputSprite);
rendered.addChildAt(fxOutput, rendered.getChildIndex(interfaceGroup));
compositor._displayContainer = fxOutput;
runTicker();

assert.equal(affectedRoot.filters, null, "FXMaster handles the affected pass itself in over-vision mode");
assert.ok(
  rendered.getChildIndex(ignoredRoot) > rendered.getChildIndex(fxOutput),
  "the ignored pass stays above FXMaster over-vision output"
);
assert.ok(
  rendered.getChildIndex(ignoredRoot) < rendered.getChildIndex(interfaceGroup),
  "the ignored pass stays below Foundry's interface group"
);

callHook("canvasTearDown");
assert.equal(mesh.renderable, true, "teardown restores the source mesh");
assert.equal(mesh.filters, null, "teardown removes only Tile Unlit's suppression filter");

console.log("Tile Unlit compatibility smoke test passed.");
