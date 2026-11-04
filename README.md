# Tile Unlit

[![Foundry VTT](https://img.shields.io/badge/Foundry_VTT-v14-informational)](https://foundryvtt.com/)
[![Latest Release](https://img.shields.io/github/v/release/Oxy949/fvtt-tile-unlit)](https://github.com/Oxy949/fvtt-tile-unlit/releases/latest)
[![License](https://img.shields.io/github/license/Oxy949/fvtt-tile-unlit)](LICENSE)

Tile Unlit adds a per-tile **Ignore Lighting** control to Foundry Virtual
Tabletop. It lets selected tiles remain visible at their original brightness,
regardless of scene darkness, Ambient Lights, or Darkness sources.

## Features

- Controls lighting independently for each tile.
- Can keep individual unlit tiles above scene weather effects. This is enabled
  by default to preserve the module's previous behavior.
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
4. Leave **Ignore Weather** enabled to display the unlit tile above weather,
   or disable it to keep weather visible over the tile.
5. Save the tile configuration.

The values are stored on each Tile document as
`flags.fvtt-tile-unlit.ignoreLighting` and
`flags.fvtt-tile-unlit.ignoreWeather`.

## Module Compatibility

- **[Gambit's FXMaster 8](https://github.com/gambit07/fxmaster):** when
  **Ignore Weather** is disabled, active FXMaster particle and filter effects
  are included in the weather-affected pass. When it is enabled, the tile is
  kept above FXMaster output, including the optional **Display Effects over
  Vision** mode. FXMaster's **Restricts Weather**, **Restricts Particles**, and
  **Restricts Filters** tile masks keep using the original live tile mesh.
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

The render pass is positioned relative to Foundry's effects and visibility
groups at runtime instead of relying on fixed child indexes.

Normally-lit tiles above an unlit tile mask its post-lighting copy, following
Foundry's elevation and sort order. The mask uses the covering tile's texture
alpha and live opacity, so transparent areas remain see-through.


If you encounter a problem, please
[open an issue](https://github.com/Oxy949/fvtt-tile-unlit/issues) and include
your Foundry version, game system, browser, and a list of active visual or
canvas-related modules.

## License

Tile Unlit is available under the [MIT License](LICENSE).
