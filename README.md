# Tile Unlit

[![Foundry VTT](https://img.shields.io/badge/Foundry_VTT-v14-informational)](https://foundryvtt.com/)
[![Latest Release](https://img.shields.io/github/v/release/Oxy949/fvtt-tile-unlit)](https://github.com/Oxy949/fvtt-tile-unlit/releases/latest)
[![License](https://img.shields.io/github/license/Oxy949/fvtt-tile-unlit)](LICENSE)

Tile Unlit adds a per-tile **Ignore Lighting** control to Foundry Virtual
Tabletop. It lets selected tiles remain visible at their original brightness,
regardless of scene darkness, Ambient Lights, or Darkness sources.

## Features

- Controls lighting independently for each tile.
- Controls scene weather independently of lighting, including normally-lit tiles.
- Preserves native snow, fog, and blizzard blending over unlit tiles.
- Offers an adjustable effect strength from `0` to `1`:
  - `0` uses Foundry's standard lighting.
  - `1` makes the tile fully ignore scene lighting.
  - Values in between blend the lit and unlit appearances.

The default value is `0`, so existing tiles keep their normal appearance until
you explicitly change the setting.

## Installation

### Install from the manifest URL

1. Open Foundry VTT and go to **Add-on Modules**.
2. Click **Install Module**.
3. Paste the following URL into **Manifest URL**:

   ```text
   https://github.com/Oxy949/fvtt-tile-unlit/releases/latest/download/module.json
   ```

4. Click **Install**, then enable **Tile Unlit** in your world.

### Install manually

1. Download `module.zip` from the
   [latest release](https://github.com/Oxy949/fvtt-tile-unlit/releases/latest).
2. Extract it into your Foundry VTT `Data/modules/fvtt-tile-unlit` directory.
3. Restart Foundry VTT and enable **Tile Unlit** in your world.

## Usage

1. Open a scene and double-click a tile to edit it.
2. Find the **Tile Lighting** section in the tile configuration window.
3. Adjust **Ignore Lighting**:
   - Use `0` for normal scene lighting.
   - Use `1` for a completely unlit tile.
   - Use a value between `0` and `1` for a partial effect.
4. Adjust **Ignore Weather** from `0` (normal scene weather) to `1` (no weather
   over the tile). Intermediate values gradually reduce weather intensity;
   for example, `0.5` ignores 50% of the weather. The default is `0`, and this
   works at every **Ignore Lighting** value.
5. Save the tile configuration.

The values are stored on each Tile document as
`flags.fvtt-tile-unlit.ignoreLighting` and
`flags.fvtt-tile-unlit.ignoreWeather`.

| Ignore Lighting | Ignore Weather | Appearance |
| --- | --- | --- |
| `0` | `0` | Normal scene lighting and weather |
| `0` | `1` | Normal scene lighting, no weather over the tile |
| `1` | `0` | Original tile brightness with weather |
| `1` | `1` | Original tile brightness without weather |
| Any | `0.5` | Half the normal weather intensity |

Ignore Weather defaults to `0` for tiles without a saved value. Old checkbox
values (`true` and `false`) are discarded and treated as `0`; saving the tile
configuration replaces them with the numeric slider value.

## Module Compatibility

- **[Gambit's FXMaster 8](https://github.com/gambit07/fxmaster) and FXMaster+:**
  **Ignore Weather** controls their visual particle and filter output from `0`
  to `1`, including tiles with **Ignore Lighting** set to `0`. The shared
  FXMaster compositor is masked in both normal and **Display Effects over
  Vision** modes, including its above-darkness output and live particle band.
  FXMaster+ effects registered in that stack use the same integration.
  Native region, foreground, and **Restricts Weather / Particles / Filters**
  masks remain in place. Unlit particle replay preserves texture alpha and
  native blend modes; partial suppression blends filtered unlit colors back
  towards the original tile colors.
- **[Darkness Activated Tiles](https://github.com/Oxy949/DarknessActivatedTiles):**
  visibility changes and configured fade transitions are mirrored from the
  live tile mesh, so a tile can be both darkness-activated and partially or
  fully unlit.

Both integrations are optional and activate automatically when the respective
module is enabled; no compatibility setting is required.

## How It Works

Foundry renders scene objects before applying its lighting effects. Tile Unlit
creates a small render pass after the lighting layer and mirrors opted-in tile
meshes into it. The original tile remains responsible for interaction, video
playback, and Foundry's normal placeable-object behavior.

At full strength the original mesh is made transparent without removing it
from the render tree. This lets canvas modules continue to inspect it for
weather masks and animate its live alpha while Tile Unlit draws the unlit copy.
Isolated off-screen captures of that mesh retain its physical coverage and
native blend mode, so FXMaster's tile masks remain valid at exactly `1`.

The render pass is positioned relative to Foundry's effects and visibility
groups at runtime instead of relying on fixed child indexes.

Normally-lit tiles above an unlit tile mask its post-lighting copy, following
Foundry's elevation and sort order. The mask uses the covering tile's texture
alpha and live opacity, so transparent areas remain see-through.

Core weather uses one screen-sized selection mask for visible tile surfaces.
The native layer retains its scene, roof, and terrain masks. Weather is excluded
where required and restored over weather-affected unlit tiles in a separate
pass, preserving the original effect blend modes instead of using per-tile
sprite masks. Lighting strength does not scale the weather selection mask.

## Development checks

Run `node tests/tile-unlit-smoke.mjs` for lifecycle and compatibility checks.
For pixel comparisons in a headless Chrome instance, run:

```text
node tests/tile-unlit-webgl.mjs <path-to-pixi.js> <path-to-chrome> [path-to-foundry-client]
```

Add `--fxmaster` to run the separate FXMaster compositor regression fixture.
It exercises opaque and transparent output, particles with normal and SCREEN
blending, filter effects, above-darkness bands, and both vision modes at
multiple lighting and weather strengths. It also checks physical tile-mask
captures and the `0.99` to `1` transition with particle fog and core blizzard
active together, including particles configured to render below tiles.

The optional Foundry client directory enables tests with the installed Snow
and Fog shaders, including their combined blizzard output. Tests read these
sources locally and do not require a running world.


If you encounter a problem, please
[open an issue](https://github.com/Oxy949/fvtt-tile-unlit/issues) and include
your Foundry version, game system, browser, and a list of active visual or
canvas-related modules.

## License

Tile Unlit is available under the [MIT License](LICENSE).
