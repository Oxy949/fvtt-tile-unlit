import { TileWeatherSelectionFilter } from "./weather-pass.js";

/** Resolve the native blend without flattening SCREEN/ADD particles as NORMAL. */
export function fxOutputBlendMode(target, ignored = new Set()) {
  const last = (target.filters ?? []).filter(filter => filter && filter.enabled !== false && !ignored.has(filter)).at(-1);
  if (last) return last.blendMode ?? PIXI.BLEND_MODES.NORMAL;
  if (target.blendMode && target.blendMode !== PIXI.BLEND_MODES.NORMAL) return target.blendMode;
  const children = (target.children ?? []).filter(child => !child.destroyed && child.visible !== false && child.renderable !== false);
  if (!children.length) return target.blendMode ?? PIXI.BLEND_MODES.NORMAL;
  const modes = new Set(children.map(child => fxOutputBlendMode(child, ignored)));
  return modes.size === 1 ? modes.values().next().value : null;
}

/** Blend a filtered unlit pass back towards its original tile colors. */
class UnlitFXWeatherFilter extends PIXI.Filter {
  constructor() {
    super(undefined, `
      precision highp float;
      varying vec2 vTextureCoord;
      uniform sampler2D uSampler;
      uniform sampler2D original;
      uniform sampler2D selection;
      uniform vec4 inputSize;
      uniform vec4 outputFrame;
      uniform vec2 screenDimensions;
      void main(void) {
        vec2 uv = (vTextureCoord * inputSize.xy + outputFrame.xy) / screenDimensions;
        float amount = texture2D(selection, uv).b;
        gl_FragColor = mix(texture2D(uSampler, vTextureCoord), texture2D(original, uv), amount);
      }
    `, { original: PIXI.Texture.EMPTY, selection: PIXI.Texture.EMPTY, screenDimensions: [1, 1] });
  }
}

/**
 * FXMaster and FXMaster+ share the native global compositor. Mask its final
 * output once, leaving the untouched scene underneath, rather than modifying
 * individual effect runtimes, their presets, or their region/tile masks.
 */
export class FXMasterWeatherPass {
  constructor() {
    this.bindings = new Map();
    this.options = null;
    this.compositor = null;
    this._present = null;
    this._presentWrapper = null;
    this._renderFrame = null;
    this._frameWrapper = null;
    this.originalTexture = null;
    this.unlitFilter = null;
    this.filteredRoot = null;
  }

  sync(options) {
    this.options = options;
    const renderer = canvas?.app?.renderer;
    const active = options.enabled && options.texture && options.rows.some(row =>
      row.visible && row.alpha > 0 && row.ignoreWeather > 0);
    if (!active || !renderer) {
      this._releaseOutputs();
      this._releaseUnlitFilter();
      this._restoreCompositor();
      this.options = null;
      return;
    }
    this._watchCompositor(options.compositor);
    this.syncOutputs();

    const blendUnlit = !options.overVision && options.filters.length && options.rows.some(row =>
      row.visible && row.strength > 0 && row.ignoreWeather > 0 && row.ignoreWeather < 1);
    if (!blendUnlit || !renderer.render) {
      this._releaseUnlitFilter();
      return;
    }
    const { width, height } = renderer.screen;
    const resolution = renderer.resolution ?? 1;
    if (!this.originalTexture || this.originalTexture.width !== width || this.originalTexture.height !== height
      || this.originalTexture.baseTexture.resolution !== resolution) {
      this.originalTexture?.destroy(true);
      this.originalTexture = PIXI.RenderTexture.create({ width, height, resolution });
    }
    // Keep the live world matrices so occlusion filters and camera transforms
    // agree with the main scene. Ancestor FX filters are not rendered here.
    options.rawRoot.getBounds?.();
    renderer.render(options.rawRoot, { renderTexture: this.originalTexture, clear: true, skipUpdateTransform: true });
    this.unlitFilter ??= new UnlitFXWeatherFilter();
    this.unlitFilter.uniforms.original = this.originalTexture;
    this.unlitFilter.uniforms.selection = options.texture;
    this.unlitFilter.uniforms.screenDimensions[0] = width;
    this.unlitFilter.uniforms.screenDimensions[1] = height;
    if (this.filteredRoot && this.filteredRoot !== options.root) this._releaseUnlitFilter();
    this.filteredRoot = options.root;
    const filters = (options.root.filters ?? []).filter(filter => filter !== this.unlitFilter);
    options.root.filters = [...filters, this.unlitFilter];
  }

  _watchCompositor(compositor) {
    if (this.compositor === compositor) return;
    this._restoreCompositor();
    if (!compositor || typeof compositor._present !== "function") return;
    const adapter = this;
    this.compositor = compositor;
    this._present = compositor._present;
    const original = this._present;
    this._presentWrapper = function(...args) {
      const result = original.apply(this, args);
      // FXMaster may create or replace display containers during renderFrame,
      // after our ticker callback. Bind the mask before that output is drawn.
      adapter.syncOutputs();
      return result;
    };
    compositor._present = this._presentWrapper;
    if (typeof compositor.renderFrame === "function") {
      this._renderFrame = compositor.renderFrame;
      const renderFrame = this._renderFrame;
      this._frameWrapper = function(...args) {
        // Native off-screen captures may draw the live above-darkness roots.
        // Mask their presented output once, not both the capture and its output.
        return adapter.withoutSourceMasks(() => renderFrame.apply(this, args));
      };
      compositor.renderFrame = this._frameWrapper;
    }
  }

  _restoreCompositor() {
    if (this.compositor?._present === this._presentWrapper) this.compositor._present = this._present;
    if (this.compositor?.renderFrame === this._frameWrapper) this.compositor.renderFrame = this._renderFrame;
    this.compositor = null;
    this._present = null;
    this._presentWrapper = null;
    this._renderFrame = null;
    this._frameWrapper = null;
  }

  syncOutputs() {
    const options = this.options;
    if (!options) return;
    const compositor = options.compositor;
    const roots = new Set([compositor?._displayContainer, compositor?._aboveDarknessDisplayContainer,
      canvas?.particleeffects?._aboveContent].filter(target => target && !target.destroyed));
    for (const parent of [canvas?.primary, canvas?.effects, canvas?.rendered]) {
      for (const child of parent?.children ?? []) {
        if (["fxmasterGlobalEffectsOutputContainer", "fxmasterAboveDarknessFilterBand"].includes(child.name)
          && !child.destroyed) roots.add(child);
      }
    }
    const ignored = new Set(this.bindings.values());
    const targets = new Map();
    const add = target => {
      const mode = fxOutputBlendMode(target, ignored);
      if (mode !== null) targets.set(target, mode);
      else for (const child of target.children ?? []) {
        if (!child.destroyed && child.visible !== false && child.renderable !== false) add(child);
      }
    };
    for (const root of roots) add(root);
    for (const [target, filter] of this.bindings) {
      if (!targets.has(target)) this._releaseOutput(target, filter);
    }
    const renderer = canvas?.app?.renderer;
    for (const [target, blendMode] of targets) {
      let filter = this.bindings.get(target);
      const native = (target.filters ?? []).filter(candidate => candidate && candidate !== filter);
      if (!filter) {
        filter = new TileWeatherSelectionFilter(options.texture, blendMode, true);
        this.bindings.set(target, filter);
      }
      filter.uniforms.selection = options.texture;
      filter.uniforms.screenDimensions[0] = renderer.screen.width;
      filter.uniforms.screenDimensions[1] = renderer.screen.height;
      filter.blendMode = blendMode;
      target.filters = [...native, filter];
    }
  }

  withoutSourceMasks(callback) {
    const states = [...this.bindings.values()].map(filter => [filter, filter.enabled]);
    try {
      for (const [filter] of states) filter.enabled = false;
      return callback();
    } finally {
      for (const [filter, enabled] of states) filter.enabled = enabled;
    }
  }

  _releaseOutput(target, filter) {
    if (!target.destroyed) {
      const filters = (target.filters ?? []).filter(candidate => candidate !== filter);
      target.filters = filters.length ? filters : null;
    }
    this.bindings.delete(target);
    filter.destroy();
  }

  _releaseOutputs() {
    for (const [target, filter] of this.bindings) this._releaseOutput(target, filter);
  }

  _releaseUnlitFilter() {
    if (this.filteredRoot && !this.filteredRoot.destroyed) {
      const filters = (this.filteredRoot.filters ?? []).filter(filter => filter !== this.unlitFilter);
      this.filteredRoot.filters = filters.length ? filters : null;
    }
    this.filteredRoot = null;
  }

  destroy() {
    this._releaseOutputs();
    this._releaseUnlitFilter();
    this._restoreCompositor();
    this.originalTexture?.destroy(true);
    this.originalTexture = null;
    this.unlitFilter?.destroy();
    this.unlitFilter = null;
    this.options = null;
  }
}
