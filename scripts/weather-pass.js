/** A screen-space mask which keeps the weather's original output blend mode. */
class TileWeatherSelectionFilter extends PIXI.Filter {
  constructor(texture, blendMode) {
    super(undefined, `
      precision highp float;
      varying vec2 vTextureCoord;
      uniform sampler2D uSampler;
      uniform sampler2D selection;
      uniform vec4 inputSize;
      uniform vec4 outputFrame;
      uniform vec2 screenDimensions;
      uniform float replay;
      void main(void) {
        vec2 uv = (vTextureCoord * inputSize.xy + outputFrame.xy) / screenDimensions;
        vec2 coverage = texture2D(selection, uv).rg;
        float amount = mix(1.0 - coverage.r, coverage.g, replay);
        gl_FragColor = texture2D(uSampler, vTextureCoord) * amount;
      }
    `, { selection: texture, screenDimensions: [1, 1], replay: 0 });
    this.blendMode = blendMode;
  }
}

/**
 * Separate core weather from tile lighting without moving Foundry's layer or
 * flattening SCREEN-blended snow/fog into a normally-blended sprite mask.
 *
 * A single texture describes the visible tile surfaces: red removes original
 * weather, green restores it after lighting. Ordinary tiles paint black, so
 * higher tiles and transparent texture holes keep their proper coverage.
 */
export class TileWeatherPass {
  constructor() {
    this.texture = null;
    this.masks = new Map();
    this.bindings = new Map();
    this.maskRoot = null;
    this.hasReplay = false;
    this._rendering = false;
    this._cameraState = null;
  }

  sync(rows, copyMeshState) {
    const weather = canvas?.weather;
    const renderer = canvas?.app?.renderer;
    const modified = rows.some(row => row.visible && row.alpha > 0 && (row.strength > 0 || row.ignoreWeather > 0));
    this.hasReplay = modified && rows.some(row => row.visible && row.alpha > 0
      && row.strength > 0 && row.ignoreWeather < 1);
    if (!modified || !weather || weather.destroyed || !renderer?.render
      || (weather.weatherEffects && !weather.weatherEffects.children.length)) {
      this._releaseBindings();
      this.hasReplay = false;
      return;
    }

    const { width, height } = renderer.screen;
    const resolution = renderer.resolution ?? 1;
    let dirty = false;
    if (!this.texture || this.texture.width !== width || this.texture.height !== height
      || this.texture.baseTexture.resolution !== resolution) {
      this.texture?.destroy(true);
      this.texture = PIXI.RenderTexture.create({ width, height, resolution });
      dirty = true;
    }
    this.maskRoot ??= new PIXI.Container();
    this.maskRoot.sortableChildren = true;
    const liveIds = new Set();
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (!row.visible || row.alpha <= 0) continue;
      liveIds.add(row.tile.id);
      let mask = this.masks.get(row.tile.id);
      if (!mask) {
        const sprite = new PIXI.Sprite(row.mesh.texture);
        const filter = new PIXI.Filter(undefined, `
          varying vec2 vTextureCoord;
          uniform sampler2D uSampler;
          uniform vec2 channels;
          void main(void) {
            float alpha = texture2D(uSampler, vTextureCoord).a;
            gl_FragColor = vec4(channels * alpha, 0.0, alpha);
          }
        `, { channels: [0, 0] });
        sprite.filters = [filter];
        this.maskRoot.addChild(sprite);
        mask = { sprite, filter };
        this.masks.set(row.tile.id, mask);
      }
      const mesh = row.mesh;
      const weatherStrength = Number(row.ignoreWeather);
      const channels = [row.strength > 0 ? 1 : weatherStrength,
        row.strength > 0 ? 1 - weatherStrength : 0];
      const state = [mesh.texture, mesh.texture?._updateID, mesh.texture?.baseTexture?.dirtyId,
        row.alpha, mesh.alpha, mesh.unoccludedAlpha, index, ...channels, mesh.rotation,
        ...[mesh.position, mesh.scale, mesh.pivot, mesh.skew, mesh.anchor].flatMap(point => [point?.x, point?.y])];
      if (!mask.state || state.some((value, index) => value !== mask.state[index])) dirty = true;
      mask.state = state;
      mask.sprite.texture = row.mesh.texture;
      copyMeshState(row.visual, mask.sprite);
      mask.sprite.tint = 0xFFFFFF;
      mask.sprite.blendMode = PIXI.BLEND_MODES.NORMAL;
      mask.sprite.zIndex = index;
      mask.filter.uniforms.channels[0] = channels[0];
      mask.filter.uniforms.channels[1] = channels[1];
    }
    for (const [id, mask] of this.masks) {
      if (liveIds.has(id)) continue;
      this._destroyMask(mask);
      this.masks.delete(id);
      dirty = true;
    }

    const camera = canvas.stage?.worldTransform;
    const cameraState = camera ? [camera.a, camera.b, camera.c, camera.d, camera.tx, camera.ty] : [];
    if (!this._cameraState || cameraState.length !== this._cameraState.length
      || cameraState.some((value, index) => value !== this._cameraState[index])) dirty = true;
    this._cameraState = cameraState;
    // Stationary tiles reuse the mask. Movement, fades, camera changes, video
    // texture updates, and resize rebuild it before the main canvas frame.
    if (dirty) {
      renderer.render(this.maskRoot, {
        renderTexture: this.texture,
        clear: true,
        transform: camera
      });
    }
    this._syncBindings(weather, renderer);
  }

  _syncBindings(weather, renderer) {
    const ownFilters = new Set([...this.bindings.values()]);
    const activeFilters = target => (target.filters ?? [])
      .filter(filter => filter && filter.enabled !== false && !ownFilters.has(filter));
    const nativeFilters = activeFilters(weather);
    let targets;
    if (nativeFilters.length) {
      targets = [{ target: weather, blendMode: nativeFilters.at(-1).blendMode }];
    } else {
      const effects = weather.weatherEffects ?? weather;
      const children = (effects.children ?? []).filter(child => !child.destroyed);
      const blendMode = child => activeFilters(child).at(-1)?.blendMode
        ?? child.blendMode ?? PIXI.BLEND_MODES.NORMAL;
      const commonBlendMode = children.length ? blendMode(children[0]) : PIXI.BLEND_MODES.NORMAL;
      // One filter suffices for the built-in snow/fog stack and for ordinary
      // particle batches. Preserve separate modes for mixed custom effects.
      targets = children.every(child => blendMode(child) === commonBlendMode)
        ? [{ target: effects, blendMode: commonBlendMode }]
        : children.map(target => ({ target, blendMode: blendMode(target) }));
    }
    const liveTargets = new Set(targets.map(row => row.target));
    for (const [target, filter] of this.bindings) {
      if (liveTargets.has(target)) continue;
      this._releaseBinding(target, filter);
    }
    for (const { target, blendMode } of targets) {
      let filter = this.bindings.get(target);
      if (!filter) {
        filter = new TileWeatherSelectionFilter(this.texture, blendMode);
        this.bindings.set(target, filter);
      }
      filter.uniforms.selection = this.texture;
      filter.uniforms.screenDimensions[0] = renderer.screen.width;
      filter.uniforms.screenDimensions[1] = renderer.screen.height;
      filter.blendMode = blendMode;
      const filters = (target.filters ?? []).filter(candidate => candidate !== filter);
      target.filters = [...filters, filter];
    }
  }

  render(renderer) {
    const weather = canvas?.weather;
    if (!this.hasReplay || !this.bindings.size || this._rendering || !weather || weather.destroyed) return;
    this._rendering = true;
    try {
      renderer.batch?.flush();
      for (const filter of this.bindings.values()) filter.uniforms.replay = 1;
      weather.render(renderer);
      renderer.batch?.flush();
    } finally {
      for (const filter of this.bindings.values()) filter.uniforms.replay = 0;
      this._rendering = false;
    }
  }

  _releaseBinding(target, filter) {
    if (!target.destroyed) {
      const filters = (target.filters ?? []).filter(candidate => candidate !== filter);
      target.filters = filters.length ? filters : null;
    }
    this.bindings.delete(target);
    filter.destroy();
  }

  _releaseBindings() {
    for (const [target, filter] of this.bindings) this._releaseBinding(target, filter);
  }

  _destroyMask(mask) {
    mask.sprite.filters = null;
    mask.filter.destroy();
    mask.sprite.destroy({ texture: false, baseTexture: false });
  }

  destroy() {
    this._releaseBindings();
    for (const mask of this.masks.values()) this._destroyMask(mask);
    this.masks.clear();
    this.maskRoot?.destroy({ children: true });
    this.maskRoot = null;
    this.texture?.destroy(true);
    this.texture = null;
    this.hasReplay = false;
    this._cameraState = null;
  }
}
