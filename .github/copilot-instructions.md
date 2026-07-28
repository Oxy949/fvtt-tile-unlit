# Foundry VTT Playlist Sync Module - AI Agent Guide

## Project Overview

**fvtt-playlist-sync** is a Foundry VTT module that automatically creates and updates playlists from a hierarchical folder structure in the server's data directory. It's designed for Foundry v13+ and supports localization (English, Russian).

**Core Purpose**: Transform folder structure on disk into organized Playlist entities without manual creation.

## Architecture & Data Flow

### Key Components

1. **PlaylistSyncMenu** (`scripts/main.js`): FormApplication-based UI for configuration and triggering sync
   - Stores `rootPath` setting (default: `assets/audio`)
   - Button triggers `_doSync()` workflow
   - GM-only access enforced

2. **File Discovery** (`collectAudioFilesRecursive()`): Recursively walks directory using Foundry's FilePicker API
   - Filters by `AUDIO_EXTENSIONS = [.mp3, .ogg, .wav, .flac, .m4a, .webm, .aac]`
   - Note: Does NOT use `options.extensions` parameter (often unreliable)

3. **Sync Plan Building** (`buildSyncPlan()`): Maps file paths to playlist hierarchy
   - Folder hierarchy: `Data/<rootPath>/<category>/<subfolder>.../<file>`
   - **Category** → Folder (Playlist Container)
   - **Subfolders** → Playlist names (e.g., `horror/crypt` becomes one playlist)
   - If no subfolders: playlist name = category name

4. **Application** (`applySyncPlan()`): Creates/updates Foundry entities
   - Folder creation (for categories)
   - Playlist creation (linked to folders)
   - Sound replacement (deletes old, adds new with metadata)

### Critical Implementation Details

- **Path Handling**: Uses `/` normalization; handles both encoded (`%D0%...`) and decoded paths
- **Sorting**: Files sorted alphabetically by decoded stem using Russian locale (`localeCompare(..., "ru")`)
- **Sound Metadata**: `name`, `path`, `repeat: false`, `volume: 0.8`, `sort` (i*10 for ordering)
- **Defensive Coding**: `safeDecode()` catches invalid URIs gracefully; filters out non-audio files

## Key Files & Patterns

| File | Purpose |
|------|---------|
| [module.json](module.json) | Manifest; defines esmodules (main.js), templates, languages, styles |
| [scripts/main.js](scripts/main.js) | All logic: hooks, class, helper functions |
| [templates/sync-menu.hbs](templates/sync-menu.hbs) | Form UI (Handlebars) with root path input |
| [lang/en.json](lang/en.json), [lang/ru.json](lang/ru.json) | Localization strings (all UI text) |
| [styles/module.css](styles/module.css) | Module styling |

## Developer Workflows

### Adding Features
1. **UI Changes**: Edit [templates/sync-menu.hbs](templates/sync-menu.hbs), add listener in `activateListeners()`
2. **Settings**: Register in `Hooks.once("init")` using `game.settings.register()` or `game.settings.registerMenu()`
3. **Localization**: Add keys to [lang/en.json](lang/en.json) and [lang/ru.json](lang/ru.json); reference as `game.i18n.localize("PLAYLISTSYNC.KeyName")`

### Testing Sync Logic
- Manually trigger via UI or call `PlaylistSyncMenu.prototype._doSync()` in browser console
- Check `console.log()` output for discovered files and plan details
- Verify notifications via `ui.notifications.info()`, `.warn()`, `.error()`

## Project-Specific Conventions

- **Module ID**: `"fvtt-playlist-sync"` (used for settings, console logging)
- **Hooks**: Only `Hooks.once("init")` used; no `setup`, `ready`, etc.
- **Permissions**: All sync operations require GM role (`game.user.isGM`)
- **Error Handling**: Try-catch in FilePicker browse; graceful fallback on bad paths
- **No External Dependencies**: Pure Foundry API; no npm packages

## Integration Points

- **Foundry Core APIs**: `game.settings`, `game.folders`, `game.playlists`, `FilePicker`, `Folder`, `Playlist`, `PlaylistSound`
- **Handlebars**: Standard Foundry template syntax; `{{{html}}}` for unsafe HTML
- **i18n**: All user-facing strings must be localized
- **FormApplication**: Standard Foundry form pattern (see `defaultOptions`, `getData`, `activateListeners`)

## Common Pitfalls to Avoid

1. **Path Normalization**: Always call `normalizePath()` before processing; don't assume consistent `/` or `\` usage
2. **File Extension Check**: Use `fileExt()` + array membership test; `FilePicker.browse()` extension filtering is unreliable
3. **Encoding**: Support both encoded and decoded path segments; use `safeDecode()` with try-catch
4. **Playlist Updates**: Always delete existing sounds before creating new ones (no merge logic)
5. **Locale Sorting**: Use `"ru"` locale for consistency with user base
6. **FormApplication lifecycle**: `_updateObject()` is intentionally empty; settings saved via `on("change")` listener

## Quick Reference

- **Scan directory**: `collectAudioFilesRecursive("data", rootPath)` → string array of normalized paths
- **Build hierarchy**: `buildSyncPlan(files, rootPath)` → `Map<category, Map<playlistName, files[]>>`
- **Apply changes**: `applySyncPlan(plan)` → returns `{playlistsTouched, soundsCreated}`
- **Reload settings**: `game.settings.get(MODULE_ID, "rootPath")`
