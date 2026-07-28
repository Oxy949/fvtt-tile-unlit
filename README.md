# Tile Unlit — Foundry VTT 14

Adds a **"Игнорировать освещение"** slider to Tile configuration:

- `0` — core Foundry rendering.
- `1` — the tile's colour is composited after scene lighting, so scene darkness and Ambient Light / Darkness sources do not change it.
- Default is `0` for every tile. The value is stored in `flags.tile-unlit.ignoreLighting`.

## Installation

Copy the `tile-unlit` directory into:

`FoundryVTT/Data/modules/tile-unlit`

Restart Foundry and enable **Tile Unlit** in the world.

## Technical note

Foundry VTT 14 renders scene objects into `PrimaryCanvasGroup` and applies lighting in a later Effects pass. Core does not expose a per-tile unlit-material switch, so this module creates a small pass after lighting and mirrors opted-in Tile meshes into it. The pass is positioned dynamically relative to `canvas.effects` and `canvas.visibility` instead of relying on fixed child indexes.

This initial build targets Foundry VTT 14.365. Test regular and overhead tiles in your own scene before relying on it for a session, especially if another module rewrites canvas group ordering.


## 0.1.4
- Fixed TileConfig preview objects replacing the real canvas Tile in the unlit pass.
- Re-syncs the persistent Tile after Apply/Close.
- Defers update synchronization until Foundry finishes refreshing the Tile mesh.


## 0.1.4
- TileConfig preview placeables are now rendered through the unlit pass too, so simply opening tile settings no longer restores normal lighting.
- Slider preview continues to work while editing the tile.
