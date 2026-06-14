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
    validate-mods.js           # Validates mods/*.json schema + commitHash
  registry.json                # Built by CI - do not edit by hand
  .github/
    workflows/
      build-registry.yml       # Runs build-registry.js on merge to main
      validate-pr.yml          # Validates mod JSON files on PRs targeting main
```

Each mod gets its own file in `mods/`. A GitHub Action builds the combined `registry.json` on every merge to `main`.

## How it works

1. **Publish** - mod creators run `ebr publish` from the mod tools, which forks this repo, creates/updates `mods/<mod-id>.json`, and opens a PR.
2. **Review** - a maintainer reviews and merges the PR.
3. **Build** - on merge, a GitHub Action reads all `mods/*.json` files, extracts browsing fields, and commits the combined `registry.json`.
4. **Fetch** - the mod manager app fetches `registry.json` on startup (browse view) and individual `mods/<id>.json` files via `raw.githubusercontent.com` when users select a mod (detail view).

## Validation

Every PR targeting `main` runs `validate-pr.yml`, which calls `scripts/validate-mods.js`:

- **Schema (all files):** every `mods/*.json` is checked for required fields, correct types, a valid `type`, well-formed `id` (kebab-case, matching the filename), `latestVersion` (semver), `commitHash` (40-char SHA-1), `updatedAt` (`YYYY-MM-DD`), `repoUrl` (GitHub URL), `language` (BCP 47), and `icon` (single character). Product fields are checked structurally (non-empty strings) but not against a fixed catalog. `includedMods` entries, when present, must be complete.
- **commitHash matches repoUrl (changed files only):** the validator calls the GitHub commits API to confirm each changed mod's recorded `commitHash` exists in its `repoUrl`. A publish PR normally changes one file; if a PR touches several, each is checked independently against its own repo. A missing commit fails the check; transient GitHub API errors (rate limit, network) are reported as non-blocking warnings.

The mod-type list in `validate-mods.js` mirrors `MOD_TYPES` in `src/core/catalogs.js` (`ebr-mod-tools`); keep the two in sync if mod types change. Product ids are intentionally not validated against a catalog here - they are advisory metadata, so the registry only checks that product fields are well-formed strings and leaves catalog enforcement to the publish-time validator.

You can run the schema checks locally with `node scripts/validate-mods.js`.

### Commit pinning

Each per-mod file records a `commitHash` - the exact git commit the mod was published from. The app downloads that specific commit, not `main`.

## Moderation

- Every submission requires maintainer approval before it appears in the app.
- Maintainers can remove a mod by deleting its file from `mods/`. CI rebuilds `registry.json` without it.
- See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community standards.

## Do not edit `registry.json` by hand

It is a build artifact generated from `mods/*.json` by CI. Edits will be overwritten on the next merge.
