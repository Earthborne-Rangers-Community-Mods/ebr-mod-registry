# ebr-mod-registry

The central directory of community mods for Earthborne Rangers. The mod manager app fetches this registry to populate its browse and detail screens.

## Structure

```
ebr-mod-registry/
  mods/                        # One file per mod (source of truth)
    expanded-boulder-field.json
    ultimate-valley-experience.json
  scripts/
    build-registry.js          # Builds registry.json from mods/*.json
  registry.json                # Built by CI - do not edit by hand
  .github/
    workflows/
      build-registry.yml       # Runs build-registry.js on merge to main
```

Each mod gets its own file in `mods/`. A GitHub Action builds the combined `registry.json` on every merge to `main`.

## How it works

1. **Publish** - mod creators run `ebr publish` from the mod tools, which forks this repo, creates/updates `mods/<mod-id>.json`, and opens a PR.
2. **Review** - a maintainer reviews and merges the PR.
3. **Build** - on merge, a GitHub Action reads all `mods/*.json` files, extracts browsing fields, and commits the combined `registry.json`.
4. **Fetch** - the mod manager app fetches `registry.json` on startup (browse view) and individual `mods/<id>.json` files via `raw.githubusercontent.com` when users select a mod (detail view).

### Commit pinning

Each per-mod file records a `commitHash` - the exact git commit the mod was published from. The app downloads that specific commit, not `main`.

## Mod types

| Type | Description |
|---|---|
| `campaign` | Standalone campaign built from scratch |
| `enhancement` | Focused modifications to existing campaign content |
| `one-day-mission` | Single-session mission designed for one sitting |
| `expansion` | New areas, story arcs, or mission chains |
| `collection` | Pre-merged combination of multiple mods |
| `theme` | Visual reskins |

## Moderation

- Every submission requires maintainer approval before it appears in the app.
- Maintainers can remove a mod by deleting its file from `mods/`. CI rebuilds `registry.json` without it.
- See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community standards.

## Do not edit `registry.json` by hand

It is a build artifact generated from `mods/*.json` by CI. Edits will be overwritten on the next merge.
