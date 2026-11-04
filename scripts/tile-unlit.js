import { TileWeatherPass } from "./weather-pass.js";
import { FXMasterWeatherPass, fxOutputBlendMode } from "./fxmaster-weather.js";

const MODULE_ID = "fvtt-tile-unlit";
const FXMASTER_ID = "fxmaster";
const DARKNESS_TILES_ID = "darkness-activated-tiles";
const LIGHTING_FLAG_KEY = "ignoreLighting";
const WEATHER_FLAG_KEY = "ignoreWeather";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/tile-unlit.hbs`;

let tileConfigTemplatePromise = null;

// TileConfig V14 renders edits through a temporary preview Placeable. Keep
// track of the active sheet and its current custom control values so our pass
// follows the preview instead of letting Foundry draw a normally-lit clone.
const configPreviewState = new Map();

/** Remove the pixels covered by a normally-lit tile above the unlit copy. */
class TileUnlitOcclusionFilter extends PIXI.Filter {
  constructor(mesh, { inverse = true } = {}) {
    super(`
      attribute vec2 aVertexPosition;
      attribute vec2 aTextureCoord;
      uniform mat3 projectionMatrix;
      uniform mat3 otherMatrix;
      varying vec2 vTextureCoord;
      varying vec2 vMaskCoord;
      void main(void) {
        gl_Position = vec4((projectionMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
        vTextureCoord = aTextureCoord;
        vMaskCoord = (otherMatrix * vec3(aTextureCoord, 1.0)).xy;
      }
    `, `
      varying vec2 vTextureCoord;
      varying vec2 vMaskCoord;
      uniform sampler2D uSampler;
      uniform sampler2D mask;
      uniform vec4 maskClamp;
      uniform float maskAlpha;
      uniform float inverse;
      void main(void) {
        float inside = step(maskClamp.x, vMaskCoord.x) * step(maskClamp.y, vMaskCoord.y)
          * step(vMaskCoord.x, maskClamp.z) * step(vMaskCoord.y, maskClamp.w);
        float coverage = texture2D(mask, vMaskCoord).a * maskAlpha * inside;
        gl_FragColor = texture2D(uSampler, vTextureCoord) * mix(coverage, 1.0 - coverage, inverse);
      }
    `, { mask: mesh.texture, otherMatrix: new PIXI.Matrix(), maskClamp: new Float32Array(4), maskAlpha: 1,
      inverse: Number(inverse) });
    this.mesh = mesh;
    this.maskMatrix = new PIXI.Matrix();
  }

  apply(filterManager, input, output, clearMode) {
    const mesh = this.mesh;
    const texture = mesh?.texture;
    if (!mesh || mesh.destroyed || !texture?.valid) {
      this.uniforms.maskAlpha = 0;
      this.uniforms.mask = PIXI.Texture.EMPTY;
    } else {
      // Use the live source transform and UVs, including rotation, mirroring,
      // config previews, and animated/video textures. Unlike SpriteMaskFilter,
      // this must never set the original mesh's renderable property to false.
      texture.uvMatrix ??= new PIXI.TextureMatrix(texture, 0);
      texture.uvMatrix.update();
      this.uniforms.mask = texture;
      this.uniforms.otherMatrix = filterManager.calculateSpriteMatrix(this.maskMatrix, mesh)
        .prepend(texture.uvMatrix.mapCoord);
      this.uniforms.maskClamp = texture.uvMatrix.uClampFrame;
    }
    filterManager.applyFilter(this, input, output, clearMode);
  }
}

/** PIXI's default sprite mask also samples red; particle masks need alpha only. */
class TileUnlitAlphaMaskFilter extends TileUnlitOcclusionFilter {
  constructor(mesh) { super(mesh, { inverse: false }); }
  get maskSprite() { return this.mesh; }
  set maskSprite(mesh) { this.mesh = mesh; }
  apply(filterManager, input, output, clearMode) {
    this.uniforms.maskAlpha = this.mesh?.worldAlpha ?? this.mesh?.alpha ?? 0;
    super.apply(filterManager, input, output, clearMode);
  }
}

/**
 * Tile Unlit for Foundry VTT v14.
 *
 * Foundry renders tangible scene objects into PrimaryCanvasGroup first and
 * applies lighting afterwards. A per-tile "unlit material" is therefore not
 * available in core. This module moves opted-in tile colour into a small pass
 * which is inserted after EffectsCanvasGroup and, whenever possible, before
 * CanvasVisibility. The original Tile placeable remains responsible for
 * interaction, occlusion state, video playback, etc.
 */
class TileUnlitPass {
  constructor() {
    /** @type {PIXI.Container|null} */
    this.root = null;
    /** @type {PIXI.Container|null} */
    this.weatherIgnoredRoot = null;
    /** @type {PIXI.Container|null} */
    this.weatherAffected = null;
    /** @type {PIXI.Container|null} */
    this.weatherOverlay = null;
    /** @type {PIXI.Container|null} */
    this.weatherIgnored = null;
    /** @type {PIXI.Container|null} */
    this.weatherMask = null;
    this.coreWeather = new TileWeatherPass();
    this.fxWeather = new FXMasterWeatherPass();
    this.coreWeatherRoot = null;
    /** @type {Map<string, {tile: any, sprite: PIXI.Sprite, weatherOverlay: PIXI.Container, weatherMask: PIXI.Sprite, weatherMaskFilter: TileUnlitAlphaMaskFilter, ignoreWeather: number, occlusionFilters: Map<string, TileUnlitOcclusionFilter>, suppressedMesh?: any, suppressionFilter?: PIXI.Filter|null}>} */
    this.entries = new Map();
    this._tickerBound = this._tick.bind(this);
    this._orderingTickerBound = this._ensureRootOrdering.bind(this);
    this._tickerAttached = false;
    this._orderingTickerAttached = false;
    this._fxMasterState = null;
    this._fxMasterFilters = [];
    this._replayFXMasterParticles = false;
    this._renderingFXMasterParticles = false;
    this._sourceRenderer = null;
    this._sourceRender = null;
    this._sourceRenderWrapper = null;
    this._sourceRenderHadOwn = false;
    this._sourceSuppressions = new WeakMap();
  }

  get active() {
    return Boolean(canvas?.ready && this.root && !this.root.destroyed);
  }

  /** Create the post-lighting container and place it as safely as possible. */
  createRoot() {
    this.destroy();
    if (!canvas?.ready) return;

    const root = new PIXI.Container();
    root.name = `${MODULE_ID}.unlitPass`;
    root.eventMode = "none";
    root.interactiveChildren = false;
    root.sortableChildren = true;

    const weatherIgnoredRoot = new PIXI.Container();
    weatherIgnoredRoot.name = `${MODULE_ID}.weatherIgnoredPass`;
    weatherIgnoredRoot.eventMode = "none";
    weatherIgnoredRoot.interactiveChildren = false;
    weatherIgnoredRoot.sortableChildren = true;

    const coreWeatherRoot = new PIXI.Container();
    coreWeatherRoot.name = `${MODULE_ID}.coreWeatherPass`;
    coreWeatherRoot.eventMode = "none";
    coreWeatherRoot.interactiveChildren = false;
    coreWeatherRoot._render = renderer => this.coreWeather.render(renderer);

    const weatherAffected = new PIXI.Container();
    weatherAffected.name = `${MODULE_ID}.weatherAffected`;
    weatherAffected.eventMode = "none";
    weatherAffected.interactiveChildren = false;
    weatherAffected.sortableChildren = true;
    weatherAffected.zIndex = 0;

    const weatherOverlay = new PIXI.Container();
    weatherOverlay.name = `${MODULE_ID}.weatherOverlay`;
    weatherOverlay.eventMode = "none";
    weatherOverlay.interactiveChildren = false;
    weatherOverlay.visible = false;
    weatherOverlay.zIndex = 1;

    const weatherIgnored = new PIXI.Container();
    weatherIgnored.name = `${MODULE_ID}.weatherIgnored`;
    weatherIgnored.eventMode = "none";
    weatherIgnored.interactiveChildren = false;
    weatherIgnored.sortableChildren = true;
    weatherIgnored.zIndex = 2;

    const weatherMask = new PIXI.Container();
    weatherMask.name = `${MODULE_ID}.weatherMask`;
    weatherMask.eventMode = "none";
    weatherMask.interactiveChildren = false;
    weatherMask.sortableChildren = true;
    weatherMask.zIndex = 3;

    root.addChild(weatherAffected, weatherOverlay, weatherMask);
    weatherIgnoredRoot.addChild(weatherIgnored);

    const effects = canvas.effects;
    const effectsParent = effects?.parent ?? canvas.environment ?? canvas.rendered;

    if (!effectsParent) {
      console.error(`${MODULE_ID} | Unable to locate a canvas container for the unlit pass.`);
      root.destroy({ children: true });
      weatherIgnoredRoot.destroy({ children: true });
      coreWeatherRoot.destroy({ children: true });
      return;
    }

    // Preferred V14 ordering: Primary -> Effects -> [Tile Unlit] -> Visibility.
    // We calculate it dynamically rather than assuming an internal child index.
    if (effects?.parent === effectsParent) {
      const effectsIndex = effectsParent.getChildIndex(effects);
      const insertIndex = Math.min(effectsIndex + 1, effectsParent.children.length);
      effectsParent.addChildAt(root, insertIndex);
      effectsParent.addChildAt(coreWeatherRoot, Math.min(insertIndex + 1, effectsParent.children.length));
      effectsParent.addChildAt(weatherIgnoredRoot, Math.min(insertIndex + 2, effectsParent.children.length));
    } else {
      effectsParent.addChild(root, coreWeatherRoot, weatherIgnoredRoot);
    }

    this.root = root;
    this.weatherIgnoredRoot = weatherIgnoredRoot;
    this.weatherAffected = weatherAffected;
    this.weatherOverlay = weatherOverlay;
    this.weatherIgnored = weatherIgnored;
    this.weatherMask = weatherMask;
    this.coreWeatherRoot = coreWeatherRoot;
    this.rebuild();
    this._attachTicker();
    this._ensureRootOrdering();

    console.info(`${MODULE_ID} | Unlit render pass created.`);
  }

  _attachTicker() {
    const ticker = canvas?.app?.ticker;
    if (!ticker) return;

    if (!this._tickerAttached) {
      ticker.add(this._tickerBound);
      this._tickerAttached = true;
    }

    // FXMaster maintains its compositor placement at a low ticker priority.
    // Run one ordering-only callback immediately afterwards so an opted-out
    // tile remains above "Display Effects over Vision" output as well.
    if (!this._orderingTickerAttached) {
      const lowPriority = PIXI.UPDATE_PRIORITY?.LOW ?? -25;
      ticker.add(this._orderingTickerBound, this, lowPriority - 1);
      this._orderingTickerAttached = true;
    }
  }

  _detachTicker() {
    if (!this._tickerAttached && !this._orderingTickerAttached) return;
    try {
      canvas?.app?.ticker?.remove(this._tickerBound);
      canvas?.app?.ticker?.remove(this._orderingTickerBound, this);
    } catch (error) {
      console.debug(`${MODULE_ID} | Ticker was already unavailable during teardown.`, error);
    }
    this._tickerAttached = false;
    this._orderingTickerAttached = false;
  }

  _isModuleActive(id) {
    return game?.modules?.get?.(id)?.active === true;
  }

  _getFXMasterSetting(key) {
    if (!this._isModuleActive(FXMASTER_ID)) return false;
    try {
      return game.settings.get(FXMASTER_ID, key) === true;
    } catch {
      return false;
    }
  }

  _invalidateFXMasterState() {
    this._fxMasterState = null;
  }

  _getFXMasterState() {
    if (this._fxMasterState) return this._fxMasterState;

    const active = this._isModuleActive(FXMASTER_ID);
    const enabled = active
      && this._getFXMasterSetting("enable")
      && !this._getFXMasterSetting("disableAll");
    this._fxMasterState = {
      enabled,
      displaysOverVision: enabled && this._getFXMasterSetting("displayEffectsOverVision")
    };
    return this._fxMasterState;
  }

  _isFXMasterEnabled() {
    return this._getFXMasterState().enabled;
  }

  _getFXMasterCompositor() {
    try {
      return globalThis.CONFIG?.fxmaster?.getGlobalEffectsCompositor?.()
        ?? globalThis.FXMASTER?.getGlobalEffectsCompositor?.() ?? null;
    } catch {
      return null;
    }
  }

  _getFXMasterOutputContainer() {
    const compositor = this._getFXMasterCompositor();
    return compositor?._displayContainer
      ?? canvas?.rendered?.children?.find?.(child => child?.name === "fxmasterGlobalEffectsOutputContainer")
      ?? null;
  }

  _fxMasterDisplaysOverVision() {
    return this._getFXMasterState().displaysOverVision;
  }

  _fxMasterOutputIsVisible() {
    if (!this._fxMasterDisplaysOverVision()) return false;

    const output = this._getFXMasterOutputContainer();
    if (!output || output.destroyed || output.parent !== canvas?.rendered) return false;
    if (output.visible === false || output.renderable === false) return false;

    const sprite = output.children?.find?.(child => child?.name === "fxmasterGlobalEffectsOutput");
    return !sprite || (sprite.visible !== false && sprite.renderable !== false && sprite.alpha > 0);
  }

  _moveAfter(child, anchor) {
    const parent = anchor?.parent;
    if (!child || !parent || child === anchor) return;

    try {
      child.parent?.removeChild?.(child);
      const index = parent.getChildIndex(anchor) + 1;
      parent.addChildAt(child, Math.min(index, parent.children.length));
    } catch (error) {
      console.debug(`${MODULE_ID} | Failed to adjust compatibility render order.`, error);
    }
  }

  _ensureAfterEffectsBeforeVisibility(child, afterChild = null) {
    const effects = canvas?.effects;
    const visibility = canvas?.visibility;
    const parent = effects?.parent ?? canvas?.environment ?? canvas?.rendered;
    if (!child || !parent) return;

    const anchor = afterChild?.parent === parent ? afterChild : effects?.parent === parent ? effects : null;
    if (!anchor) {
      if (child.parent !== parent) parent.addChild(child);
      return;
    }

    if (child.parent === parent) {
      const childIndex = parent.getChildIndex(child);
      const anchorIndex = parent.getChildIndex(anchor);
      const visibilityIndex = visibility?.parent === parent ? parent.getChildIndex(visibility) : -1;
      if (childIndex > anchorIndex && (visibilityIndex < 0 || childIndex < visibilityIndex)) return;
    }

    this._moveAfter(child, anchor);
  }

  /** Keep the two passes on the correct sides of FXMaster's optional output. */
  _ensureRootOrdering() {
    if (!this.root || this.root.destroyed || !this.weatherIgnoredRoot || this.weatherIgnoredRoot.destroyed) return;

    this._ensureAfterEffectsBeforeVisibility(this.root);
    this._ensureAfterEffectsBeforeVisibility(this.coreWeatherRoot, this.root);
    this.fxWeather.syncOutputs();

    const fxOutput = this._getFXMasterOutputContainer();
    if (this._fxMasterOutputIsVisible() && fxOutput?.parent) {
      const parent = fxOutput.parent;
      const interfaceGroup = canvas?.interface;
      const outputIndex = parent.getChildIndex(fxOutput);
      const ignoredIndex = this.weatherIgnoredRoot.parent === parent
        ? parent.getChildIndex(this.weatherIgnoredRoot)
        : -1;
      const interfaceIndex = interfaceGroup?.parent === parent ? parent.getChildIndex(interfaceGroup) : -1;
      const correctlyPlaced = ignoredIndex > outputIndex && (interfaceIndex < 0 || ignoredIndex < interfaceIndex);
      if (!correctlyPlaced) this._moveAfter(this.weatherIgnoredRoot, fxOutput);
      return;
    }

    this._ensureAfterEffectsBeforeVisibility(this.weatherIgnoredRoot, this.coreWeatherRoot);
  }

  _getFXMasterFilters() {
    if (!this._isFXMasterEnabled()) return [];

    const sceneManager = globalThis.FXMASTER?.filters ?? null;
    const regionLayer = canvas?.filtereffects ?? null;
    const compositor = this._getFXMasterCompositor();
    const rows = Array.isArray(compositor?._stackRowsFrame) ? compositor._stackRowsFrame : [];
    const filters = [];
    const seen = new Set();
    const add = filter => {
      if (!filter || filter.destroyed || filter.enabled === false || seen.has(filter)) return;
      seen.add(filter);
      filters.push(filter);
    };

    // FXMaster stores the UI stack top-to-bottom and composites it in reverse.
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index];
      if (row?.kind !== "filter" || !row.uid) continue;
      add(sceneManager?.getStackFilter?.(row.uid) ?? regionLayer?.getStackFilter?.(row.uid));
    }

    // During the first compositor frame the ordered row cache is not populated
    // yet. Use the live registries as a one-frame fallback.
    if (!filters.length) {
      for (const entry of sceneManager?.stackEntries?.values?.() ?? []) add(entry?.filter);
      for (const entry of regionLayer?.stackEntries?.values?.() ?? []) add(entry?.filter);
    }

    return filters;
  }

  _syncFXMasterCompatibility() {
    if (!this.root || this.root.destroyed) return;

    // When FXMaster presents over vision it captures this pass itself. In its
    // normal primary-group mode, apply the live filter runtimes here and replay
    // particle slots below so unlit tiles do not accidentally cover them.
    const letFXMasterCapturePass = this._fxMasterDisplaysOverVision();
    this._replayFXMasterParticles = this._isFXMasterEnabled() && !letFXMasterCapturePass;
    const filters = letFXMasterCapturePass ? [] : this._getFXMasterFilters();
    const unchanged = filters.length === this._fxMasterFilters.length
      && filters.every((filter, index) => filter === this._fxMasterFilters[index]);

    if (!unchanged) {
      this.root.filters = filters.length ? filters : null;
      this.root.filterArea = filters.length ? canvas?.app?.renderer?.screen ?? null : null;
      this._fxMasterFilters = filters;
    }
  }

  _getFXMasterParticleBlendMode() {
    const ignored = new Set(this.fxWeather.bindings.values());
    const modes = new Set();
    for (const entry of canvas?.particleeffects?.stackEntries?.values?.() ?? []) {
      if (!entry?.root || entry.root.destroyed || !entry?.slot || entry.slot.destroyed) continue;
      const last = (entry.root.filters ?? [])
        .filter(filter => filter && filter.enabled !== false && !ignored.has(filter)).at(-1);
      modes.add(last?.blendMode ?? fxOutputBlendMode(entry.slot, ignored));
    }
    return modes.size === 1 ? modes.values().next().value : null;
  }

  rebuild() {
    if (!this.root || !canvas?.tiles) return;

    const liveIds = new Set();
    for (const tile of canvas.tiles.placeables ?? []) {
      if (!tile?.id) continue;
      liveIds.add(tile.id);
      this.syncTile(tile);
    }

    for (const id of this.entries.keys()) {
      if (!liveIds.has(id)) this.removeTile(id);
    }
  }

  /** @param {any} tile */
  syncTile(tile) {
    if (!this.root || !tile?.document || !tile.id) return;

    // Always store the persistent Placeable. TileConfig previews deliberately
    // share its source identity and are short-lived.
    const canonicalTile = canvas?.tiles?.get?.(tile.id);
    if (canonicalTile?.document) tile = canonicalTile;

    const strength = this._getEffectiveStrength(tile);
    if (strength <= 0) {
      this.removeTile(tile.id, tile);
      return;
    }

    // When TileConfig is open Foundry hides the original and draws a preview
    // Placeable instead. Follow that preview's mesh so opening the sheet does
    // not suddenly re-introduce normal lighting.
    const visualTile = this._getVisualTile(tile);
    const mesh = visualTile?.mesh;
    if (!mesh?.texture) return;
    const ignoreWeather = this._getEffectiveIgnoreWeather(tile);

    let entry = this.entries.get(tile.id);
    if (!entry || entry.tile !== tile || entry.sprite.destroyed) {
      if (entry) this.removeTile(tile.id, entry.tile);

      const sprite = new PIXI.Sprite(mesh.texture);
      sprite.name = `${MODULE_ID}.${tile.id}`;
      sprite.eventMode = "none";
      sprite.interactiveChildren = false;

      const weatherMask = new PIXI.Sprite(mesh.texture);
      weatherMask.name = `${MODULE_ID}.${tile.id}.weatherMask`;
      weatherMask.eventMode = "none";
      weatherMask.interactiveChildren = false;
      this.weatherMask.addChild(weatherMask);

      // FXMaster particle replay retains its compatibility mask. Core weather
      // uses one separate pass which preserves native effect blend modes.
      const weatherOverlay = new PIXI.Container();
      weatherOverlay.name = `${MODULE_ID}.${tile.id}.weatherOverlay`;
      weatherOverlay.eventMode = "none";
      weatherOverlay.interactiveChildren = false;
      weatherOverlay.visible = false;
      const weatherMaskFilter = new TileUnlitAlphaMaskFilter(weatherMask);
      weatherMask.renderable = false;

      const weatherReplay = new PIXI.Container();
      weatherReplay.name = `${MODULE_ID}.${tile.id}.weatherReplay`;
      weatherReplay.eventMode = "none";
      weatherReplay.interactiveChildren = false;
      weatherReplay._render = renderer => this._renderWeather(renderer, entry);
      weatherOverlay.addChild(weatherReplay);
      this.weatherOverlay.addChild(weatherOverlay);

      entry = {
        tile,
        sprite,
        weatherOverlay,
        weatherMask,
        weatherMaskFilter,
        ignoreWeather,
        occlusionFilters: new Map(),
        suppressedMesh: null,
        suppressionFilter: null
      };
      this.entries.set(tile.id, entry);
    }

    this._syncEntry(entry, visualTile, strength, ignoreWeather);
  }

  /** Keep post-lighting copies behind the ordinary tiles in Foundry's order. */
  _syncTileOcclusion() {
    const compare = canvas?.primary?.constructor?._compareObjects;
    const rows = (canvas?.tiles?.placeables ?? []).map((tile, index) => {
      const visual = this._getVisualTile(tile);
      return { tile, visual, mesh: visual?.mesh, index };
    }).filter(row => row.mesh && !row.mesh.destroyed);
    rows.sort((a, b) => {
      if (compare) return compare(a.mesh, b.mesh) || a.index - b.index;
      // The same tuple as PrimaryCanvasGroup; do not pack elevation and sort
      // into one zIndex, since sort values can exceed any chosen multiplier.
      return ((a.mesh.elevation ?? a.visual.document.elevation ?? 0)
        - (b.mesh.elevation ?? b.visual.document.elevation ?? 0))
        || ((a.mesh.sortLayer ?? 0) - (b.mesh.sortLayer ?? 0))
        || ((a.mesh.sort ?? a.visual.document.sort ?? 0) - (b.mesh.sort ?? b.visual.document.sort ?? 0))
        || ((a.mesh.zIndex ?? 0) - (b.mesh.zIndex ?? 0))
        || ((a.mesh._lastSortedIndex ?? a.index) - (b.mesh._lastSortedIndex ?? b.index));
    });

    for (const row of rows) {
      row.bounds = row.mesh.getBounds?.();
      row.alpha = this._clampStrength(row.mesh.alpha
        * this._clampStrength(row.mesh.unoccludedAlpha ?? row.visual.document.alpha ?? 1));
      row.visible = Boolean(row.visual.isVisible && row.mesh.visible
        && (row.mesh.renderable !== false || this.entries.get(row.tile.id)?.suppressedMesh === row.mesh));
      row.strength = this._getEffectiveStrength(row.tile);
      row.ignoreWeather = this._getEffectiveIgnoreWeather(row.tile);
      row.blocks = row.visible && row.mesh.renderable && row.alpha > 0 && row.strength <= 0;
    }

    const particleBlendMode = this._getFXMasterParticleBlendMode();
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const entry = this.entries.get(row.tile.id);
      if (!entry) continue;
      entry.sprite.zIndex = entry.weatherMask.zIndex = index;
      const blockers = new Set();
      for (const above of rows.slice(index + 1)) {
        const aboveEntry = this.entries.get(above.tile.id);
        const crossesWeatherPass = above.visible && above.alpha > 0 && aboveEntry
          && aboveEntry.sprite.parent !== entry.sprite.parent;
        if (!above.blocks && !crossesWeatherPass) continue;
        const a = row.bounds;
        const b = above.bounds;
        if (a && b && (a.x + a.width <= b.x || b.x + b.width <= a.x
          || a.y + a.height <= b.y || b.y + b.height <= a.y)) continue;
        blockers.add(above.tile.id);
        let filter = entry.occlusionFilters.get(above.tile.id);
        if (!filter) {
          filter = new TileUnlitOcclusionFilter(above.mesh);
          entry.occlusionFilters.set(above.tile.id, filter);
        }
        filter.mesh = above.mesh;
        filter.uniforms.maskAlpha = above.alpha;
      }
      for (const [id, filter] of entry.occlusionFilters) {
        if (blockers.has(id)) continue;
        entry.occlusionFilters.delete(id);
        filter.destroy();
      }
      const filters = [...entry.occlusionFilters.values()];
      entry.sprite.filters = filters.length ? filters : null;
      entry.groupedParticleMask = particleBlendMode !== null;
      if (entry.groupedParticleMask) {
        // Fade a common particle stack once, so overlapping sources do not
        // compound the slider value. Preserve its native output blend mode.
        entry.weatherMaskFilter.blendMode = particleBlendMode;
        entry.weatherOverlay.filters = [...filters, entry.weatherMaskFilter];
        entry.weatherOverlay.filterArea = row.bounds ?? canvas.app.renderer.screen;
      } else {
        entry.weatherOverlay.filters = null;
        entry.weatherOverlay.filterArea = null;
      }
    }
    const fxEnabled = this._isFXMasterEnabled();
    this.coreWeather.sync(rows, (tile, sprite) => this._copyMeshState(tile, sprite), { externalWeather: fxEnabled });
    this.fxWeather.sync({ rows, texture: this.coreWeather.hasSelection ? this.coreWeather.texture : null,
      root: this.root, rawRoot: this.weatherAffected, filters: this._fxMasterFilters,
      compositor: this._getFXMasterCompositor(), enabled: fxEnabled, overVision: this._fxMasterDisplaysOverVision() });
  }

  _syncEntry(entry, visualTile, strength, ignoreWeather) {
    const mesh = visualTile?.mesh;
    if (!mesh?.texture || entry.sprite.destroyed) return;

    if (entry.sprite.texture !== mesh.texture) entry.sprite.texture = mesh.texture;
    this._copyMeshState(visualTile, entry.sprite, strength);

    const spriteContainer = ignoreWeather >= 1 ? this.weatherIgnored : this.weatherAffected;
    if (entry.sprite.parent !== spriteContainer) spriteContainer.addChild(entry.sprite);
    entry.ignoreWeather = ignoreWeather;

    if (!entry.weatherMask.destroyed) {
      if (entry.weatherMask.texture !== mesh.texture) entry.weatherMask.texture = mesh.texture;
      const blendFilteredPass = this._fxMasterFilters.length && !this._fxMasterDisplaysOverVision();
      this._copyMeshState(visualTile, entry.weatherMask, strength * (blendFilteredPass ? 1 : 1 - ignoreWeather));
      entry.weatherMask.tint = 0xFFFFFF;
      entry.weatherMask.visible = ignoreWeather < 1 && entry.sprite.visible && (entry.weatherMask.alpha > 0);
    }
    entry.weatherOverlay.visible = entry.weatherMask.visible;
    this._updateWeatherOverlayVisibility();

    // If the visual source changed (usually original -> config preview), restore
    // any mesh we suppressed on the previous source before suppressing the new
    // one. This avoids leaking suppression across the preview lifecycle.
    if (entry.suppressedMesh && entry.suppressedMesh !== mesh) {
      this._releaseMeshSuppression(entry, entry.suppressedMesh);
    }

    // Fractional values are a normal-lit base plus an unlit copy. At 1.0 the
    // base mesh, including TileConfig's preview mesh, must not be drawn at all.
    // Prefer a transparent PIXI filter over renderable=false: FXMaster needs a
    // live, renderable source mesh for its tile/weather masks, while Darkness
    // Activated Tiles animates mesh.alpha directly during fade transitions.
    if (strength >= 1) this._suppressMesh(entry, mesh);
    else this._releaseMeshSuppression(entry, mesh);
  }

  _trackSourceRenders() {
    const renderer = canvas?.app?.renderer;
    if (!renderer?.render || this._sourceRenderer === renderer) return;
    this._releaseSourceRenderer();
    const pass = this;
    const render = renderer.render;
    this._sourceRenderer = renderer;
    this._sourceRender = render;
    this._sourceRenderHadOwn = Object.hasOwn(renderer, "render");
    this._sourceRenderWrapper = function(source, ...args) {
      const suppression = pass._sourceSuppressions.get(source);
      const filters = source?.filters;
      const isolatedMesh = args[0]?.renderTexture && suppression && filters?.includes(suppression);
      // FXMaster renders the live mesh by itself to build physical tile masks.
      // Only scene/base captures should see the transparent original. Removing
      // our filter for the isolated draw also preserves native ERASE blending.
      if (isolatedMesh) source.filters = filters.filter(filter => filter !== suppression);
      try {
        return render.call(this, source, ...args);
      } finally {
        if (isolatedMesh) source.filters = filters;
      }
    };
    renderer.render = this._sourceRenderWrapper;
  }

  _releaseSourceRenderer() {
    if (this._sourceRenderer?.render === this._sourceRenderWrapper) {
      if (this._sourceRenderHadOwn) this._sourceRenderer.render = this._sourceRender;
      else delete this._sourceRenderer.render;
    }
    this._sourceRenderer = this._sourceRender = this._sourceRenderWrapper = null;
    this._sourceSuppressions = new WeakMap();
  }

  _createSuppressionFilter() {
    const AlphaFilter = PIXI.AlphaFilter ?? PIXI.filters?.AlphaFilter;

    try {
      const filter = AlphaFilter
        ? new AlphaFilter(0)
        : PIXI.Filter
          ? new PIXI.Filter(undefined, `
              varying vec2 vTextureCoord;
              uniform sampler2D uSampler;
              void main(void) { gl_FragColor = vec4(0.0); }
            `)
          : null;
      if (!filter) return null;
      if ("alpha" in filter) filter.alpha = 0;
      filter.__tileUnlitSuppression = true;
      return filter;
    } catch (error) {
      console.debug(`${MODULE_ID} | A transparent PIXI filter is unavailable; using renderable suppression.`, error);
      return null;
    }
  }

  _suppressMesh(entry, mesh) {
    if (!mesh || mesh.destroyed) return;

    this._trackSourceRenders();
    entry.suppressionFilter ??= this._createSuppressionFilter();
    const filter = entry.suppressionFilter;
    if (!filter || filter.destroyed) {
      mesh.renderable = false;
      entry.suppressedMesh = mesh;
      return;
    }

    const filters = Array.isArray(mesh.filters) ? mesh.filters.filter(Boolean) : [];
    if (!filters.includes(filter)) mesh.filters = [...filters, filter];
    mesh.renderable = true;
    entry.suppressedMesh = mesh;
    this._sourceSuppressions.set(mesh, filter);
  }

  _releaseMeshSuppression(entry, mesh = entry.suppressedMesh) {
    if (!mesh) return;
    this._sourceSuppressions.delete(mesh);

    const filter = entry.suppressionFilter;
    if (!mesh.destroyed) {
      if (filter && Array.isArray(mesh.filters) && mesh.filters.includes(filter)) {
        const filters = mesh.filters.filter(candidate => candidate !== filter);
        mesh.filters = filters.length ? filters : null;
      }
      mesh.renderable = true;
    }

    if (entry.suppressedMesh === mesh) entry.suppressedMesh = null;
  }

  /**
   * Return the temporary config preview when one exists, otherwise the real Tile.
   * V14 exposes preview Placeables through the layer preview container and gives
   * them the same sourceId as their original.
   */
  _getVisualTile(tile) {
    const state = configPreviewState.get(tile.id);
    const appPreview = state?.app?._preview?.object;
    if (appPreview?.isPreview && appPreview?.mesh && !appPreview.destroyed) return appPreview;

    const previewContainer = canvas?.tiles?.preview;
    const children = previewContainer?.children ?? [];
    for (const child of children) {
      if (!child?.isPreview || !child?.mesh || child.destroyed) continue;
      if (child._original === tile) return child;
      if (child.sourceId && tile.sourceId && child.sourceId === tile.sourceId) return child;
    }

    return tile;
  }

  _getEffectiveStrength(tile) {
    const state = configPreviewState.get(tile.id);
    if (state && Number.isFinite(state.strength)) {
      return this._clampStrength(state.strength);
    }
    return this._getStrength(tile.document);
  }

  _getEffectiveIgnoreWeather(tile) {
    const state = configPreviewState.get(tile.id);
    if (state && Number.isFinite(state.ignoreWeather)) return this._clampStrength(state.ignoreWeather);
    return this._getIgnoreWeather(tile.document);
  }

  _clampStrength(value) {
    value = Number(value);
    if (!Number.isFinite(value)) return 0;
    return Math.clamp ? Math.clamp(value, 0, 1) : Math.min(1, Math.max(0, value));
  }

  /**
   * Mirror the visual state Foundry computes for the real Tile mesh.
   * This is intentionally copied from the live mesh instead of rebuilding a
   * transform from document data, which keeps anchors, negative dimensions,
   * rotation, video textures and future V14 transform details aligned.
   */
  _copyMeshState(tile, sprite, strength = 1) {
    const mesh = tile.mesh;
    if (!mesh || !sprite) return;

    sprite.position.copyFrom(mesh.position);
    sprite.scale.copyFrom(mesh.scale);
    sprite.pivot.copyFrom(mesh.pivot);
    sprite.skew.copyFrom(mesh.skew);
    sprite.rotation = mesh.rotation;

    if (sprite.anchor && mesh.anchor) sprite.anchor.copyFrom(mesh.anchor);

    // Tile opacity is applied by Foundry's PrimarySpriteMesh occlusion shader
    // through unoccludedAlpha, so it is not included in mesh.alpha. Our plain
    // PIXI.Sprite has no such shader and must apply that opacity explicitly.
    // Prefer the live mesh value so TileConfig previews and other live canvas
    // adjustments are mirrored, with the document value as a safe fallback.
    const tileAlpha = this._clampStrength(mesh.unoccludedAlpha ?? tile.document?.alpha ?? 1);
    sprite.alpha = mesh.alpha * tileAlpha * strength;
    sprite.tint = mesh.tint ?? 0xFFFFFF;
    sprite.blendMode = mesh.blendMode;
    // Let Foundry decide whether the Placeable is visible (including GM handling
    // of hidden objects); do not independently reinterpret the hidden flag here.
    sprite.visible = Boolean(tile.isVisible && mesh.visible);

    // zIndex is assigned from Foundry's complete ordering in _syncTileOcclusion.
  }

  _getStrength(document) {
    return this._clampStrength(document?.getFlag?.(MODULE_ID, LIGHTING_FLAG_KEY) ?? 0);
  }

  _getIgnoreWeather(document) {
    const value = document?.getFlag?.(MODULE_ID, WEATHER_FLAG_KEY);
    // Discard the old checkbox state. Only slider values carry weather strength.
    return typeof value === "boolean" ? 0 : this._clampStrength(value ?? 0);
  }

  _renderWeather(renderer, tileEntry) {
    if (!this.weatherOverlay?.visible) return;

    if (this._replayFXMasterParticles) this._renderFXMasterParticles(renderer, tileEntry);
  }

  /** Replay FXMaster's transparent particle slots inside the active tile mask. */
  _renderFXMasterParticles(renderer, tileEntry) {
    const layer = canvas?.particleeffects;
    if (this._renderingFXMasterParticles || !renderer || !layer?.stackEntries?.size || !tileEntry) return;

    const entries = [...layer.stackEntries.values()]
      .filter(entry => entry?.root && entry?.slot && !entry.root.destroyed && !entry.slot.destroyed)
      .sort((a, b) => {
        const az = Number(a.slot?.zIndex ?? a.zIndex ?? 0);
        const bz = Number(b.slot?.zIndex ?? b.zIndex ?? 0);
        return az - bz;
      });

    this._renderingFXMasterParticles = true;
    try {
      for (const entry of entries) {
        const { root, slot } = entry;
        const runtime = entry.fx;
        const container = entry.container ?? slot;
        const isRegion = entry.scope === "region" || Boolean(entry.regionId);

        // Scene sources are deliberately left renderable=false by FXMaster
        // while its global compositor owns them. Their runtime/container state
        // therefore cannot be used as an enabled check here: membership in
        // stackEntries is the source of truth. Region sources have additional
        // live visibility gates, matching FXMaster's renderStackParticle path.
        if (isRegion) {
          const compositorSuppressed = Boolean(
            container?.__fxmCompositorSourceSuppressed || slot?.__fxmCompositorSourceSuppressed
          );
          if (runtime?.destroyed || (runtime && "enabled" in runtime && runtime.enabled === false)) continue;
          if (container?.visible === false) continue;
          if (container?.renderable === false && !compositorSuppressed) continue;
        }

        const candidates = layer._stackRoots?.get?.(root) ?? new Set([slot]);
        const previousCandidates = [];
        const previousRoot = { visible: root.visible, renderable: root.renderable };

        try {
          // FXMaster prepares scene/region masks immediately before every
          // compositor draw. Replaying the raw root without this step can use
          // an empty or stale bucket mask and render no particles at all.
          if (isRegion) layer._applyRegionMaskForEntry?.(entry);
          else layer._applySceneMaskForEntry?.(root, entry);

          for (const candidate of candidates) {
            if (!candidate || candidate.destroyed) continue;
            previousCandidates.push([candidate, candidate.visible, candidate.renderable]);
            const show = candidate === slot;
            candidate.visible = show;
            candidate.renderable = show;
          }

          root.visible = true;
          root.renderable = true;
          this.fxWeather.withoutSourceMasks(() => {
            root.getBounds?.();
            tileEntry.weatherMask.getBounds?.();
            if (tileEntry.groupedParticleMask) {
              root.render(renderer);
              return;
            }
            const filters = root.filters;
            const blendMode = fxOutputBlendMode(root) ?? PIXI.BLEND_MODES.NORMAL;
            tileEntry.weatherMaskFilter.blendMode = blendMode;
            try {
              root.filters = [...(filters ?? []), ...tileEntry.occlusionFilters.values(), tileEntry.weatherMaskFilter];
              root.render(renderer);
            } finally {
              root.filters = filters;
            }
          });
        } catch (error) {
          console.debug(`${MODULE_ID} | Failed to replay an FXMaster particle slot.`, error);
        } finally {
          root.visible = previousRoot.visible;
          root.renderable = previousRoot.renderable;
          for (const [candidate, visible, renderable] of previousCandidates) {
            if (!candidate || candidate.destroyed) continue;
            candidate.visible = visible;
            candidate.renderable = renderable;
          }
        }
      }
    } finally {
      this._renderingFXMasterParticles = false;
    }
  }

  _updateWeatherOverlayVisibility() {
    if (!this.weatherOverlay) return;
    this.weatherOverlay.visible = [...this.entries.values()].some(entry => entry.weatherOverlay.visible);
  }

  /** @param {string} id @param {any} [tileHint] */
  removeTile(id, tileHint) {
    const entry = this.entries.get(id);
    const tile = tileHint ?? entry?.tile;

    if (entry) {
      this.entries.delete(id);

      this._releaseMeshSuppression(entry);
      try {
        entry.suppressionFilter?.destroy?.();
      } catch (error) {
        console.debug(`${MODULE_ID} | Failed to destroy a mesh suppression filter.`, error);
      }
      entry.suppressionFilter = null;

      entry.sprite.filters = entry.weatherOverlay.filters = null;
      for (const filter of entry.occlusionFilters.values()) filter.destroy();
      entry.occlusionFilters.clear();

      entry.weatherOverlay.mask = null;
      entry.weatherMaskFilter?.destroy();
      for (const object of [entry.sprite, entry.weatherOverlay, entry.weatherMask]) {
        try {
          object.destroy({ children: true, texture: false, baseTexture: false });
        } catch (error) {
          console.warn(`${MODULE_ID} | Failed to destroy an unlit render object for ${id}.`, error);
        }
      }

      this._updateWeatherOverlayVisibility();
    }

    // Ask core to resume drawing the real mesh. Setting renderable first makes
    // this immediate; render flags let Foundry restore its own visibility state.
    if (tile?.mesh && !tile.mesh.destroyed) {
      tile.mesh.renderable = true;
      tile.renderFlags?.set?.({ refreshState: true, refreshVisibility: true, refreshMesh: true });
    }
  }

  _tick() {
    if (!this.root || this.root.destroyed) return;

    this._syncFXMasterCompatibility();

    for (const [id, entry] of this.entries) {
      const tile = entry.tile;
      if (!tile?.mesh || tile.mesh.destroyed || !tile.document) {
        this.removeTile(id, tile);
        continue;
      }

      // Foundry may replace meshes and TileConfig may swap the visible source to
      // a temporary preview at any time. Resolve the source on every frame.
      const strength = this._getEffectiveStrength(tile);
      if (strength <= 0) {
        this.removeTile(id, tile);
        continue;
      }

      const visualTile = this._getVisualTile(tile);
      if (!visualTile?.mesh || visualTile.mesh.destroyed) continue;
      this._syncEntry(entry, visualTile, strength, this._getEffectiveIgnoreWeather(tile));
    }
    this._syncTileOcclusion();
  }

  destroy() {
    this._detachTicker();
    this.fxWeather.destroy();
    this.coreWeather.destroy();
    if (this.coreWeatherRoot && !this.coreWeatherRoot.destroyed) {
      this.coreWeatherRoot.parent?.removeChild(this.coreWeatherRoot);
      this.coreWeatherRoot.destroy({ children: true });
    }
    this.coreWeatherRoot = null;

    for (const [id, entry] of [...this.entries]) {
      this.removeTile(id, entry.tile);
    }
    this.entries.clear();
    this._releaseSourceRenderer();

    if (this.root && !this.root.destroyed) {
      try {
        this.root.filters = null;
        this.root.filterArea = null;
        this.root.parent?.removeChild(this.root);
        this.root.destroy({ children: true });
      } catch (error) {
        console.debug(`${MODULE_ID} | Error while destroying unlit pass.`, error);
      }
    }

    if (this.weatherIgnoredRoot && !this.weatherIgnoredRoot.destroyed) {
      try {
        this.weatherIgnoredRoot.parent?.removeChild(this.weatherIgnoredRoot);
        this.weatherIgnoredRoot.destroy({ children: true });
      } catch (error) {
        console.debug(`${MODULE_ID} | Error while destroying weather-ignored pass.`, error);
      }
    }

    this.root = null;
    this.weatherIgnoredRoot = null;
    this.weatherAffected = null;
    this.weatherOverlay = null;
    this.weatherIgnored = null;
    this.weatherMask = null;
    this._fxMasterFilters = [];
    this._fxMasterState = null;
    this._replayFXMasterParticles = false;
    this._renderingFXMasterParticles = false;
  }
}

const unlitPass = new TileUnlitPass();

Hooks.once("init", () => {
  console.info(`${MODULE_ID} | Initializing.`);
});

Hooks.on("canvasReady", () => {
  unlitPass._invalidateFXMasterState();
  unlitPass.createRoot();
});

Hooks.on("canvasTearDown", () => {
  unlitPass.destroy();
});

for (const hookName of ["updateSetting", "createSetting", "clientSettingChanged"]) {
  Hooks.on(hookName, () => unlitPass._invalidateFXMasterState());
}

Hooks.on("createTile", (document) => {
  queueMicrotask(() => {
    const tile = canvas?.tiles?.get?.(document.id) ?? document.object;
    if (tile) unlitPass.syncTile(tile);
  });
});

Hooks.on("updateTile", (document) => {
  // Let core finish refreshing/replacing the Tile mesh before re-syncing our
  // post-lighting copy. One animation frame is enough and avoids racing the
  // TileConfig preview teardown on submit.
  requestAnimationFrame(() => {
    const tile = canvas?.tiles?.get?.(document.id) ?? document.object;
    if (tile) unlitPass.syncTile(tile);
  });
});

Hooks.on("deleteTile", (document) => {
  unlitPass.removeTile(document.id, document.object);
});

// Darkness Activated Tiles starts its fade animations from lightingRefresh and
// writes every intermediate value to the live mesh alpha. Rebuild after its
// hook turn, then let the normal ticker mirror the animation frame-for-frame.
Hooks.on("lightingRefresh", () => {
  if (game?.modules?.get?.(DARKNESS_TILES_ID)?.active !== true) return;
  requestAnimationFrame(() => unlitPass.rebuild());
});

// A generic object refresh catches local previews and core-side refreshes which
// do not necessarily produce a document update until the interaction ends.
Hooks.on("refreshObject", (object) => {
  if (object?.document?.documentName !== "Tile") return;

  // Resolve by id so a TileConfig preview can never become the stored entry.
  const tile = canvas?.tiles?.get?.(object.id) ?? object;
  unlitPass.syncTile(tile);
});

// PlaceableConfig destroys its temporary preview as the sheet closes. Re-sync
// afterwards so Apply/Close always leaves the persistent Tile in the pass.
Hooks.on("closeTileConfig", (app) => {
  const document = app.document ?? app.object;
  if (!document?.id) return;

  configPreviewState.delete(document.id);

  requestAnimationFrame(() => {
    const tile = canvas?.tiles?.get?.(document.id) ?? document.object;
    if (tile) unlitPass.syncTile(tile);
  });
});

/**
 * Add the Tile Unlit controls to Foundry V14's TileConfig using a real
 * Handlebars template, matching Foundry's normal fieldset/category layout.
 */
Hooks.on("renderTileConfig", async (app, html) => {
  const document = app.document ?? app.object;
  if (!document || document.documentName !== "Tile") return;

  const root = html instanceof jQuery ? html[0] : html;
  if (!root?.querySelector) return;

  const rawValue = Number(document.getFlag(MODULE_ID, LIGHTING_FLAG_KEY) ?? 0);
  const numericValue = Number.isFinite(rawValue) ? Math.min(1, Math.max(0, rawValue)) : 0;
  const value = numericValue.toFixed(2);
  const ignoreWeather = unlitPass._getIgnoreWeather(document);
  const weatherValue = ignoreWeather.toFixed(2);

  // Register the config session before doing any DOM work. TileConfig may have
  // already initialized its preview by the time this hook fires.
  configPreviewState.set(document.id, { app, strength: numericValue, ignoreWeather });
  const canonicalTile = canvas?.tiles?.get?.(document.id) ?? document.object;
  if (canonicalTile) unlitPass.syncTile(canonicalTile);

  if (root.querySelector(`[data-${MODULE_ID}]`)) return;

  try {
    tileConfigTemplatePromise ??= foundry.applications.handlebars.getTemplate(TEMPLATE_PATH);
    const template = await tileConfigTemplatePromise;
    const injectHtml = template({ value, weatherValue });

    // The sheet may have been closed while the template was loading.
    if (!root.isConnected || root.querySelector(`[data-${MODULE_ID}]`)) return;

    const form = root.querySelector("form") ?? root;

    // Match Foundry's own layout instead of appending blindly. Prefer the
    // appearance controls, then gracefully fall back if the sheet changes.
    const anchors = [
      '[name="texture.tint"]',
      '[name="alpha"]',
      'div[data-tab="appearance"] .form-group:last-of-type',
      'div[data-tab="basic"] .form-group:last-of-type',
      '.form-group:last-of-type'
    ];

    let anchor = null;
    for (const selector of anchors) {
      anchor = root.querySelector(selector);
      if (anchor) break;
    }

    const anchorGroup = anchor?.closest?.(".form-group");
    if (anchorGroup) anchorGroup.insertAdjacentHTML("afterend", injectHtml);
    else form.insertAdjacentHTML("beforeend", injectHtml);

    const fieldset = root.querySelector(`[data-${MODULE_ID}]`);
    const lightingInput = fieldset?.querySelector(`[name="flags.${MODULE_ID}.${LIGHTING_FLAG_KEY}"]`);
    const weatherInput = fieldset?.querySelector(`[name="flags.${MODULE_ID}.${WEATHER_FLAG_KEY}"]`);

    lightingInput?.addEventListener("input", () => {
      const numeric = Number(lightingInput.value);

      const state = configPreviewState.get(document.id);
      if (state && Number.isFinite(numeric)) state.strength = Math.min(1, Math.max(0, numeric));

      const tile = canvas?.tiles?.get?.(document.id) ?? document.object;
      if (tile) unlitPass.syncTile(tile);
    });

    weatherInput?.addEventListener("input", () => {
      const numeric = Number(weatherInput.value);
      const state = configPreviewState.get(document.id);
      if (state && Number.isFinite(numeric)) state.ignoreWeather = Math.min(1, Math.max(0, numeric));

      const tile = canvas?.tiles?.get?.(document.id) ?? document.object;
      if (tile) unlitPass.syncTile(tile);
    });

    try { app.setPosition({ height: "auto" }); } catch { }
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to render TileConfig template.`, error);
  }
});
