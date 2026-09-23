# SpotDos → Android 4.4.4 (API 19)

## Why this is a port and not a setting
Jetpack Compose, Coil 2, DataStore, AppCompat 1.7, Lifecycle 2.8, Activity 1.9, Navigation-Compose
and Media3 1.5 all require Android 5.0+ (API 21+). Nothing can be "lowered": the UI has to be
rebuilt on Views (AppCompat / RecyclerView), and everything else swapped for API 19-safe parts.

## Stage 1 (this drop) – foundation, done
* `minSdk 19`, multidex, core-library desugaring, all libraries pinned to API-19-capable versions
  (Media3 1.3.1, AppCompat 1.6.1, Lifecycle 2.6.2, Coroutines 1.7.3 …), Compose removed.
* DataStore → `compat/DataStoreCompat.kt` (same API, file-backed JSON, atomic writes).
  Repositories only changed their imports.
* Coil → `ui/components/ArtworkLoader.kt` (LruCache + 2 threads, recycling-safe `bind(view, uri, …)`).
* `AudioOutput.kt`: API 23 device list split from a legacy path (headset / Bluetooth flags + receiver).
* `AudioDecoder.kt`: MediaCodec buffer arrays for API < 21.
* `HumSearch.kt`: battery / power-save checks without API 21-23 calls.
* `DocumentTree.kt`: folder (tree) grants exist only on 5.0+; guarded.
* Legacy launcher PNGs, notification icon PNGs, v21-split theme.
* All 15 ViewModels, the search engine, hum search, tag editor, library scan, playback service are
  kept as they were.
* `MainActivity` is a ListView skeleton that proves scan + playback on API 19.

## Stage 2+ – screens (Compose → Views), source in `compose-reference/`
Home, Library, Search, Folders, Player, Equalizer, Settings, Summary, Profile/Auth, Detail screens,
mini-player, song sheet, theme/styles, icons (Material icons → vector XML).

## Not verifiable in the sandbox
No Google Maven access there, so nothing was compiled. First build on your machine / GitHub Actions
may show small compile errors to fix in stage 1 files.
