const MODULE_ID = "fvtt-tile-unlit";
const FLAG_KEY = "ignoreLighting";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/tile-unlit.hbs`;

let tileConfigTemplatePromise = null;

// TileConfig V14 renders edits through a temporary preview Placeable. Keep
// track of the active sheet and its current custom slider value so our pass
// follows the preview instead of letting Foundry draw a normally-lit clone.
const configPreviewState = new Map();

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
    /** @type {Map<string, {tile: any, sprite: PIXI.Sprite, suppressedMesh?: any}>} */
    this.entries = new Map();
    this._tickerBound = this._tick.bind(this);
    this._tickerAttached = false;
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

    const effects = canvas.effects;
    const visibility = canvas.visibility;
    const effectsParent = effects?.parent ?? canvas.environment ?? canvas.rendered;

    if (!effectsParent) {
      console.error(`${MODULE_ID} | Unable to locate a canvas container for the unlit pass.`);
      root.destroy({ children: true });
      return;
    }

    // Preferred V14 ordering: Primary -> Effects -> [Tile Unlit] -> Visibility.
    // We calculate it dynamically rather than assuming an internal child index.
    if (effects?.parent === effectsParent) {
      const effectsIndex = effectsParent.getChildIndex(effects);
      let insertIndex = effectsIndex + 1;

      if (visibility?.parent === effectsParent) {
        const visibilityIndex = effectsParent.getChildIndex(visibility);
        insertIndex = Math.min(insertIndex, visibilityIndex);
        if (visibilityIndex <= effectsIndex) insertIndex = effectsIndex + 1;
      }

      effectsParent.addChildAt(root, Math.min(insertIndex, effectsParent.children.length));
    } else {
      effectsParent.addChild(root);
    }

    this.root = root;
    this.rebuild();
    this._attachTicker();

    console.info(`${MODULE_ID} | Unlit render pass created.`);
  }

  _attachTicker() {
    if (this._tickerAttached || !canvas?.app?.ticker) return;
    canvas.app.ticker.add(this._tickerBound);
    this._tickerAttached = true;
  }

  _detachTicker() {
    if (!this._tickerAttached) return;
    try {
      canvas?.app?.ticker?.remove(this._tickerBound);
    } catch (error) {
      console.debug(`${MODULE_ID} | Ticker was already unavailable during teardown.`, error);
    }
    this._tickerAttached = false;
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

    let entry = this.entries.get(tile.id);
    if (!entry || entry.tile !== tile || entry.sprite.destroyed) {
      if (entry) this.removeTile(tile.id, entry.tile);

      const sprite = new PIXI.Sprite(mesh.texture);
      sprite.name = `${MODULE_ID}.${tile.id}`;
      sprite.eventMode = "none";
      sprite.interactiveChildren = false;
      this.root.addChild(sprite);

      entry = { tile, sprite, suppressedMesh: null };
      this.entries.set(tile.id, entry);
    }

    this._syncEntry(entry, visualTile, strength);
  }

  _syncEntry(entry, visualTile, strength) {
    const mesh = visualTile?.mesh;
    if (!mesh?.texture || entry.sprite.destroyed) return;

    if (entry.sprite.texture !== mesh.texture) entry.sprite.texture = mesh.texture;
    this._copyMeshState(visualTile, entry.sprite, strength);

    // If the visual source changed (usually original -> config preview), restore
    // any mesh we suppressed on the previous source before suppressing the new
    // one. This avoids leaking renderable=false across the preview lifecycle.
    if (entry.suppressedMesh && entry.suppressedMesh !== mesh && !entry.suppressedMesh.destroyed) {
      entry.suppressedMesh.renderable = true;
      entry.suppressedMesh = null;
    }

    // Fractional values are a normal-lit base plus an unlit copy. At 1.0 the
    // base mesh, including TileConfig's preview mesh, must not be drawn at all.
    mesh.renderable = strength < 1;
    if (strength >= 1) entry.suppressedMesh = mesh;
    else if (entry.suppressedMesh === mesh) entry.suppressedMesh = null;
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

    sprite.alpha = mesh.alpha * strength;
    sprite.tint = mesh.tint ?? 0xFFFFFF;
    sprite.blendMode = mesh.blendMode;
    // Let Foundry decide whether the Placeable is visible (including GM handling
    // of hidden objects); do not independently reinterpret the hidden flag here.
    sprite.visible = Boolean(tile.isVisible && mesh.visible);

    // Preserve deterministic order between multiple opted-in tiles.
    const elevation = Number(tile.document.elevation ?? 0);
    const sort = Number(tile.document.sort ?? 0);
    sprite.zIndex = (elevation * 1_000_000) + sort;
  }

  _getStrength(document) {
    return this._clampStrength(document?.getFlag?.(MODULE_ID, FLAG_KEY) ?? 0);
  }

  /** @param {string} id @param {any} [tileHint] */
  removeTile(id, tileHint) {
    const entry = this.entries.get(id);
    const tile = tileHint ?? entry?.tile;

    if (entry) {
      this.entries.delete(id);

      if (entry.suppressedMesh && !entry.suppressedMesh.destroyed) {
        entry.suppressedMesh.renderable = true;
      }

      try {
        entry.sprite.destroy({ children: true, texture: false, baseTexture: false });
      } catch (error) {
        console.warn(`${MODULE_ID} | Failed to destroy unlit sprite ${id}.`, error);
      }
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
      this._syncEntry(entry, visualTile, strength);
    }
  }

  destroy() {
    this._detachTicker();

    for (const [id, entry] of [...this.entries]) {
      this.removeTile(id, entry.tile);
    }
    this.entries.clear();

    if (this.root && !this.root.destroyed) {
      try {
        this.root.parent?.removeChild(this.root);
        this.root.destroy({ children: true });
      } catch (error) {
        console.debug(`${MODULE_ID} | Error while destroying unlit pass.`, error);
      }
    }

    this.root = null;
  }
}

const unlitPass = new TileUnlitPass();

Hooks.once("init", () => {
  console.info(`${MODULE_ID} | Initializing.`);
});

Hooks.on("canvasReady", () => {
  unlitPass.createRoot();
});

Hooks.on("canvasTearDown", () => {
  unlitPass.destroy();
});

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

  const rawValue = Number(document.getFlag(MODULE_ID, FLAG_KEY) ?? 0);
  const numericValue = Number.isFinite(rawValue) ? Math.min(1, Math.max(0, rawValue)) : 0;
  const value = numericValue.toFixed(1);

  // Register the config session before doing any DOM work. TileConfig may have
  // already initialized its preview by the time this hook fires.
  configPreviewState.set(document.id, { app, strength: numericValue });
  const canonicalTile = canvas?.tiles?.get?.(document.id) ?? document.object;
  if (canonicalTile) unlitPass.syncTile(canonicalTile);

  if (root.querySelector(`[data-${MODULE_ID}]`)) return;

  try {
    tileConfigTemplatePromise ??= foundry.applications.handlebars.getTemplate(TEMPLATE_PATH);
    const template = await tileConfigTemplatePromise;
    const injectHtml = template({ value });

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
    const input = fieldset?.querySelector('range-picker');

    input?.addEventListener("input", () => {
      const numeric = Number(input.value);

      const state = configPreviewState.get(document.id);
      if (state && Number.isFinite(numeric)) state.strength = Math.min(1, Math.max(0, numeric));

      const tile = canvas?.tiles?.get?.(document.id) ?? document.object;
      if (tile) unlitPass.syncTile(tile);
    });

    try { app.setPosition({ height: "auto" }); } catch { }
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to render TileConfig template.`, error);
  }
});
