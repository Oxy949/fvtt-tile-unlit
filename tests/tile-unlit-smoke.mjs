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
    this.blendMode = 0;
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

class Filter {
  constructor(vertex, fragment, uniforms = {}) {
    this.uniforms = uniforms;
    this.destroyed = false;
    this.enabled = true;
    this.blendMode = 0;
  }

  destroy() {
    this.destroyed = true;
  }
}

class AlphaFilter extends Filter {
  constructor(alpha = 1) {
    super();
    this.alpha = alpha;
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
  Filter,
  Matrix: class Matrix {},
  AlphaFilter,
  filters: { AlphaFilter },
  UPDATE_PRIORITY: { LOW: -25 },
  BLEND_MODES: { NORMAL: 0, SCREEN: 3 },
  RenderTexture: { create({ width, height, resolution }) {
    return { width, height, baseTexture: { resolution }, destroy() { this.destroyed = true; } };
  } }
};
globalThis.requestAnimationFrame = callback => callback();
globalThis.jQuery = class JQuery {};

const rendered = new Container();
const effects = new Container();
const visibility = new Container();
const interfaceGroup = new Container();
rendered.addChild(effects, visibility, interfaceGroup);

const flags = {
  "fvtt-tile-unlit": { ignoreLighting: 1, ignoreWeather: 0 },
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
  app: { ticker, renderer: { screen: { width: 128, height: 128 }, resolution: 1, render() {} } },
  tiles: {
    placeables: [tile],
    get: id => canvas.tiles.placeables.find(tile => tile.id === id) ?? null,
    preview: { children: [] }
  },
  weather: new Container()
};
canvas.weather.weatherEffects = new Container();
const snowEffect = new Sprite();
snowEffect.blendMode = PIXI.BLEND_MODES.SCREEN;
canvas.weather.weatherEffects.addChild(snowEffect);
canvas.weather.addChild(canvas.weather.weatherEffects);
canvas.weather.render = () => coreWeatherRenders++;
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
assert.equal(coreWeatherRenders, 0, "FXMaster's per-tile replay does not redraw core weather");
const coreWeatherRoot = rendered.children.find(child => child.name === "fvtt-tile-unlit.coreWeatherPass");
coreWeatherRoot.render({});
assert.equal(coreWeatherRenders, 1, "core weather is replayed once through its independent pass");
assert.equal(canvas.weather.weatherEffects.filters.at(-1).blendMode, PIXI.BLEND_MODES.SCREEN,
  "core snow keeps its SCREEN output blend mode");
assert.equal(particleRenders, 1, "FXMaster particles are replayed through the tile mask");

flags["fvtt-tile-unlit"].ignoreWeather = 1;
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

// Regression: a normal tile must cover a lower unlit tile in both passes.
const coverDocument = {
  id: "cover", documentName: "Tile", elevation: 0, sort: 10, alpha: 1,
  getFlag() { return 0; }
};
const coverMesh = new Sprite({ id: "cover-texture" });
coverMesh.unoccludedAlpha = 1;
const cover = { id: coverDocument.id, document: coverDocument, mesh: coverMesh, isVisible: true };
canvas.tiles.placeables.push(cover);
runTicker();
assert.equal(unlitSprite.filters.length, 1, "a higher ordinary tile masks the unlit copy");
const coverFilter = unlitSprite.filters[0];
assert.equal(coverFilter.mesh, coverMesh, "the mask samples the live covering texture and transform");
assert.equal(coverFilter.uniforms.maskAlpha, 1, "an opaque covering tile fully blocks the unlit copy");
assert.equal(coverMesh.renderable, true, "using a tile as an inverse mask does not hide its lit mesh");
assert.equal(coverMesh.filters, null, "the covering tile's rendering is untouched");
assert.equal(overlay.children[0].filters[0], coverFilter, "weather replay is clipped by the same cover");

coverMesh.alpha = 0.5;
coverMesh.unoccludedAlpha = 0.4;
runTicker();
assert.equal(unlitSprite.filters[0], coverFilter, "mask filters are reused between frames");
assert.equal(coverFilter.uniforms.maskAlpha, 0.2, "mask coverage follows live fade and tile opacity");

cover.isVisible = false;
runTicker();
assert.equal(unlitSprite.filters, null, "invisible tiles do not cover the unlit copy");
assert.equal(coverFilter.destroyed, true, "unused mask filters are destroyed");
cover.isVisible = true;
coverDocument.sort = -10;
runTicker();
assert.equal(unlitSprite.filters, null, "ordinary tiles below the unlit tile do not mask it");
coverDocument.elevation = 1;
document.sort = 2_000_000;
runTicker();
assert.equal(unlitSprite.filters.length, 1, "elevation takes precedence even over very large sort values");

coverMesh.getBounds = () => ({ x: 200, y: 200, width: 100, height: 100 });
mesh.getBounds = () => ({ x: 0, y: 0, width: 100, height: 100 });
runTicker();
assert.equal(unlitSprite.filters, null, "non-overlapping tiles do not allocate masking passes");
coverMesh.getBounds = () => ({ x: 0, y: 0, width: 100, height: 100 });
runTicker();
assert.equal(unlitSprite.filters.length, 1, "moving a covering tile into the unlit tile updates its mask");

const previewMesh = new Sprite({ id: "cover-preview-texture" });
previewMesh.unoccludedAlpha = 0.3;
const coverPreview = { ...cover, mesh: previewMesh, isPreview: true, _original: cover };
canvas.tiles.preview.children.push(coverPreview);
runTicker();
assert.equal(unlitSprite.filters[0].mesh, previewMesh, "cover masks follow live TileConfig previews");
assert.equal(unlitSprite.filters[0].uniforms.maskAlpha, 0.3, "preview opacity is reflected in coverage");
canvas.tiles.preview.children.length = 0;
runTicker();
assert.equal(unlitSprite.filters[0].mesh, coverMesh, "closing a cover preview restores the persistent mesh");

// Foundry's live mesh ordering can differ from the document during previews.
let nativeComparisons = 0;
canvas.primary = { constructor: { _compareObjects(a, b) {
  nativeComparisons++;
  return a === coverMesh ? -1 : 1;
} } };
runTicker();
assert.ok(nativeComparisons > 0, "Foundry's native mesh comparator is used when available");
assert.equal(unlitSprite.filters, null, "live mesh ordering takes precedence over document ordering");
delete canvas.primary;

flags["fvtt-tile-unlit"].ignoreWeather = 0;
callHook("updateTile", document);
runTicker();
assert.equal(unlitSprite.parent, affected, "the regression also covers the weather-affected pass");
assert.equal(unlitSprite.filters.length, 1, "tile occlusion survives switching weather mode");
for (const previousValue of [true, false, undefined]) {
  flags["fvtt-tile-unlit"].ignoreWeather = previousValue;
  callHook("updateTile", document);
  runTicker();
  assert.equal(unlitSprite.parent, affected, "old boolean or missing weather values default to zero");
}
flags["fvtt-tile-unlit"].ignoreWeather = 0.5;
callHook("updateTile", document);
runTicker();
assert.equal(unlitSprite.parent, affected, "partial weather suppression keeps the unlit copy below the weather pass");
const fxMask = affectedRoot.children.find(child => child.name === "fvtt-tile-unlit.weatherMask").children[0];
assert.equal(fxMask.alpha, unlitSprite.alpha * 0.5, "partial weather suppression scales FXMaster particle replay");
flags["fvtt-tile-unlit"].ignoreWeather = 0;
callHook("updateTile", document);
runTicker();
const teardownFilter = unlitSprite.filters[0];

canvas.tiles.placeables.pop();
runTicker();
assert.equal(unlitSprite.filters, null, "removing the ordinary tile removes its occlusion");
assert.equal(teardownFilter.destroyed, true, "removing the ordinary tile releases its mask filter");
canvas.tiles.placeables.push(cover);
runTicker();
const finalFilter = unlitSprite.filters[0];

callHook("canvasTearDown");
assert.equal(mesh.renderable, true, "teardown restores the source mesh");
assert.equal(mesh.filters, null, "teardown removes only Tile Unlit's suppression filter");
assert.equal(finalFilter.destroyed, true, "teardown destroys tile occlusion filters");
assert.equal(canvas.weather.weatherEffects.filters, null, "teardown restores core weather filters");

// Weather selection is independent of the unlit entry lifecycle.
const { TileWeatherPass } = await import("../scripts/weather-pass.js");
const weatherPass = new TileWeatherPass();
let selectionRenders = 0;
canvas.app.renderer.render = () => selectionRenders++;
const row = { tile, visual: tile, mesh, visible: true, alpha: 1, strength: 0, ignoreWeather: 0 };
const copyMaskState = (visual, sprite) => { sprite.alpha = visual.mesh.alpha; };
weatherPass.sync([row], copyMaskState);
assert.equal(canvas.weather.weatherEffects.filters, null, "normal lighting with weather enabled needs no compositor");
row.ignoreWeather = 1;
weatherPass.sync([row], copyMaskState);
const initialSelectionRenders = selectionRenders;
weatherPass.sync([row], copyMaskState);
assert.equal(selectionRenders, initialSelectionRenders, "stationary tiles reuse the weather selection texture");
mesh.position.x += 1;
weatherPass.sync([row], copyMaskState);
assert.equal(selectionRenders, initialSelectionRenders + 1, "moving a tile rebuilds its weather selection mask");
assert.equal(weatherPass.hasReplay, false, "ignoring weather at lighting strength zero does not replay weather");
assert.deepEqual(weatherPass.masks.get(tile.id).filter.uniforms.channels, [1, 0],
  "ignoring weather at lighting strength zero masks the original weather");
row.strength = 1;
row.ignoreWeather = 0;
weatherPass.sync([row], copyMaskState);
assert.equal(weatherPass.hasReplay, true, "fully unlit tiles can retain core weather");
assert.deepEqual(weatherPass.masks.get(tile.id).filter.uniforms.channels, [1, 1],
  "weather is removed from the lit base and restored over the unlit copy");
row.ignoreWeather = 0.5;
weatherPass.sync([row], copyMaskState);
assert.equal(weatherPass.hasReplay, true, "partial weather suppression keeps replay active");
assert.deepEqual(weatherPass.masks.get(tile.id).filter.uniforms.channels, [1, 0.5],
  "unlit tiles replay the remaining weather intensity");
row.strength = 0;
weatherPass.sync([row], copyMaskState);
assert.deepEqual(weatherPass.masks.get(tile.id).filter.uniforms.channels, [0.5, 0],
  "normally lit tiles suppress weather proportionally");
row.strength = 1;
row.ignoreWeather = 1;
weatherPass.sync([row], copyMaskState);
assert.equal(weatherPass.hasReplay, false, "fully unlit tiles can independently exclude core weather");
assert.deepEqual(weatherPass.masks.get(tile.id).filter.uniforms.channels, [1, 0],
  "fully unlit weather-ignoring tiles suppress only the weather");
row.strength = 0.5;
row.ignoreWeather = 0;
weatherPass.sync([row], copyMaskState);
assert.deepEqual(weatherPass.masks.get(tile.id).filter.uniforms.channels, [1, 1],
  "partial lighting strength does not fade weather coverage");
const foreignWeatherFilter = new Filter();
foreignWeatherFilter.blendMode = PIXI.BLEND_MODES.SCREEN;
canvas.weather.filters = [foreignWeatherFilter];
weatherPass.sync([row], copyMaskState);
assert.equal(canvas.weather.weatherEffects.filters, null, "native layer-wide filtering switches the mask to that layer");
assert.equal(canvas.weather.filters[0], foreignWeatherFilter, "native layer-wide weather filters are preserved");
assert.equal(canvas.weather.filters.at(-1).blendMode, foreignWeatherFilter.blendMode,
  "layer-wide native filtering keeps its final output blend mode");
const previousTexture = weatherPass.texture;
canvas.app.renderer.screen.width = 256;
weatherPass.sync([row], copyMaskState);
assert.equal(previousTexture.destroyed, true, "resizing releases the old selection texture");
assert.equal(weatherPass.texture.width, 256, "the weather selection texture follows canvas resize");
weatherPass.destroy();
assert.deepEqual(canvas.weather.filters, [foreignWeatherFilter], "weather teardown preserves third-party filters");

console.log("Tile Unlit compatibility smoke test passed.");
