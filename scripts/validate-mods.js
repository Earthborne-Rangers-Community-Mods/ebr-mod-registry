/**
 * Validate per-mod registry files (mods/*.json).
 *
 * Two layers of checking:
 *   1. Schema validation (offline, deterministic) - runs on every file.
 *      Required fields, field types, enum values, formats, and the
 *      filename <-> id match.
 *   2. commitHash <-> repoUrl verification (online) - runs only on the files
 *      passed in CHANGED_FILES. Confirms the recorded commit actually exists
 *      in the named GitHub repo via the commits API. Skipped when no files are
 *      flagged as changed. Uses GITHUB_TOKEN when present (authenticated, higher
 *      rate limit); falls back to an unauthenticated request otherwise.
 *
 * This is a standalone, dependency-free CommonJS script (the registry repo has
 * no package.json). The mod-type list below mirrors `MOD_TYPES` in
 * `src/core/catalogs.js` (`ebr-mod-tools`); keep the two in sync if mod types
 * change (rare). Product ids are NOT validated against a catalog here: products
 * are advisory metadata, the official list grows with every release, and an
 * unknown-but-well-formed id degrades gracefully in the app, so product fields
 * are checked structurally (non-empty strings) instead. The publish-time
 * manifest validator in `ebr-mod-tools` enforces the full product catalog.
 *
 * Usage:
 *   node scripts/validate-mods.js
 *   CHANGED_FILES="mods/foo.json mods/bar.json" GITHUB_TOKEN=... node scripts/validate-mods.js
 *
 * Exits 0 when all files pass, 1 when any file fails. Failures are printed as
 * GitHub Actions error annotations (::error file=...::message).
 */

const fs = require("fs");
const path = require("path");

const MODS_DIR = path.resolve(__dirname, "..", "mods");

// --- Catalogs ---
// Only the mod-type list is mirrored from ebr-mod-tools/src/core/catalogs.js
// (MOD_TYPES). It is small and effectively fixed, so duplicating it is cheap.

const MOD_TYPES = ["enhancement", "expansion", "one-day-mission", "campaign", "collection", "theme"];

// --- Field formats ---

const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+/;
const SHA1_RE = /^[0-9a-f]{40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GITHUB_REPO_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

const REQUIRED_FIELDS = [
  "id",
  "name",
  "author",
  "description",
  "repoUrl",
  "type",
  "campaigns",
  "requiredProducts",
  "safeToAddMidCampaign",
  "language",
  "latestVersion",
  "updatedAt",
  "commitHash",
];

const INCLUDED_MOD_REQUIRED_FIELDS = ["id", "name", "author", "version", "repoUrl"];

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isValidLanguageTag(v) {
  if (!isNonEmptyString(v)) return false;
  try {
    Intl.getCanonicalLocales(v.trim());
    return true;
  } catch {
    return false;
  }
}

function isSingleGrapheme(v) {
  if (!isNonEmptyString(v)) return false;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return [...segmenter.segment(v)].length === 1;
}

function isValidDate(v) {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Validate one parsed registry entry against the schema.
 * @param {*} entry - Parsed JSON object.
 * @param {string} expectedId - The id implied by the filename (mods/<id>.json).
 * @returns {string[]} Human-readable error messages (empty when valid).
 */
function validateEntry(entry, expectedId) {
  const errors = [];

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return ["Mod entry must be a JSON object."];
  }

  for (const field of REQUIRED_FIELDS) {
    if (entry[field] === undefined || entry[field] === null) {
      errors.push(`Missing required field: "${field}".`);
    }
  }

  // id: kebab-case and must match the filename.
  // Type-specific checks below use `!= null` so a field explicitly set to JSON
  // null produces only the "missing required field" error above, not a second
  // confusing type error.
  if (entry.id != null) {
    if (typeof entry.id !== "string" || !KEBAB_CASE_RE.test(entry.id)) {
      errors.push(`"id" must be kebab-case (lowercase letters, numbers, hyphens). Got "${entry.id}".`);
    } else if (entry.id !== expectedId) {
      errors.push(`"id" ("${entry.id}") must match the filename ("${expectedId}.json").`);
    }
  }

  for (const field of ["name", "author", "description"]) {
    if (entry[field] != null && !isNonEmptyString(entry[field])) {
      errors.push(`"${field}" must be a non-empty string.`);
    }
  }

  if (entry.type != null && !MOD_TYPES.includes(entry.type)) {
    errors.push(`Invalid type "${entry.type}". Must be one of: ${MOD_TYPES.join(", ")}.`);
  }

  if (entry.latestVersion != null && !SEMVER_RE.test(String(entry.latestVersion))) {
    errors.push(`"latestVersion" must be a semver string (e.g. "1.0.0"). Got "${entry.latestVersion}".`);
  }

  if (entry.repoUrl != null && !GITHUB_REPO_RE.test(String(entry.repoUrl))) {
    errors.push(`"repoUrl" must be a GitHub repo URL (https://github.com/<owner>/<repo>). Got "${entry.repoUrl}".`);
  }

  if (entry.commitHash != null && !SHA1_RE.test(String(entry.commitHash))) {
    errors.push(`"commitHash" must be a full 40-character SHA-1 hex string. Got "${entry.commitHash}".`);
  }

  if (entry.updatedAt != null && !isValidDate(String(entry.updatedAt))) {
    errors.push(`"updatedAt" must be a valid YYYY-MM-DD date. Got "${entry.updatedAt}".`);
  }

  if (entry.safeToAddMidCampaign != null && typeof entry.safeToAddMidCampaign !== "boolean") {
    errors.push(`"safeToAddMidCampaign" must be a boolean.`);
  }

  if (entry.language != null && !isValidLanguageTag(entry.language)) {
    errors.push(`"language" must be a valid BCP 47 language tag (e.g. "en", "es", "zh-Hans"). Got "${entry.language}".`);
  }

  if (entry.icon != null && !isSingleGrapheme(entry.icon)) {
    errors.push(`"icon" must be exactly one character. Got "${entry.icon}".`);
  }

  if (entry.authorDiscord != null && typeof entry.authorDiscord !== "string") {
    errors.push(`"authorDiscord" must be a string.`);
  }

  if (entry.midCampaignNotes != null && typeof entry.midCampaignNotes !== "string") {
    errors.push(`"midCampaignNotes" must be a string.`);
  }

  // Array fields.
  for (const field of ["campaigns", "requiredProducts", "optionalProducts", "tags"]) {
    if (entry[field] != null && !Array.isArray(entry[field])) {
      errors.push(`"${field}" must be an array.`);
    }
  }

  if (Array.isArray(entry.campaigns)) {
    // An empty campaigns array is allowed. Entries that are present must be non-empty.
    for (const c of entry.campaigns) {
      if (!isNonEmptyString(c)) {
        errors.push(`"campaigns" entries must be non-empty strings.`);
        break;
      }
    }
  }

  if (Array.isArray(entry.tags)) {
    for (const tag of entry.tags) {
      if (typeof tag !== "string" || !KEBAB_CASE_RE.test(tag)) {
        errors.push(`"tags" entries must be kebab-case strings. Got "${tag}".`);
      }
    }
  }

  // Product entries must be non-empty strings. The set of valid product ids is
  // intentionally not enforced here (see the file header): products are
  // advisory metadata, an unknown-but-well-formed id degrades gracefully in the
  // app, and the publish-time manifest validator already checks ids against the
  // full catalog.
  for (const field of ["requiredProducts", "optionalProducts"]) {
    if (Array.isArray(entry[field])) {
      for (const value of entry[field]) {
        if (!isNonEmptyString(value)) {
          errors.push(`"${field}" entries must be non-empty strings.`);
          break;
        }
      }
    }
  }

  // Collections are validated for includedMods *shape* below when the field is
  // present, but includedMods is not required at the registry tier: a valid
  // collection may be built only from official campaigns (tracked in the
  // manifest's includedCampaigns, which is not mirrored into registry entries).
  // The publish-time manifest validator enforces the includedMods-OR-
  // includedCampaigns rule.

  // includedMods entries (when present) must be complete. Per-entry fields are
  // checked for presence/non-empty only - not URL shape - to match the
  // publish-time manifest validator (INCLUDED_MOD_REQUIRED_FIELDS in
  // ebr-mod-tools), which treats includedMods as lineage/credit metadata.
  if (entry.includedMods != null) {
    if (!Array.isArray(entry.includedMods)) {
      errors.push(`"includedMods" must be an array.`);
    } else {
      entry.includedMods.forEach((mod, i) => {
        if (!mod || typeof mod !== "object") {
          errors.push(`includedMods[${i}] must be an object.`);
          return;
        }
        for (const field of INCLUDED_MOD_REQUIRED_FIELDS) {
          if (!isNonEmptyString(mod[field])) {
            errors.push(`includedMods[${i}] is missing required field: "${field}".`);
          }
        }
      });
    }
  }

  return errors;
}

/**
 * Verify that a commit hash exists in the named GitHub repo.
 * @param {string} repoUrl - https://github.com/<owner>/<repo>
 * @param {string} commitHash - Full SHA-1.
 * @param {string|undefined} token - GitHub token for authenticated requests.
 * @returns {Promise<{ok: boolean, transient: boolean, message: string}>}
 */
async function verifyCommit(repoUrl, commitHash, token) {
  const match = GITHUB_REPO_RE.exec(String(repoUrl));
  if (!match) {
    return { ok: false, transient: false, message: `Cannot parse owner/repo from repoUrl "${repoUrl}".` };
  }
  const [, owner, repo] = match;
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${commitHash}`;

  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ebr-mod-registry-validator",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    return { ok: false, transient: true, message: `Network error contacting GitHub: ${err.message}` };
  }

  if (res.status === 200) {
    return { ok: true, transient: false, message: "" };
  }
  // 404/422: commit or repo not found. 409: repo exists but is empty (no
  // commits), so any recorded commitHash is definitively wrong. All three are
  // permanent data errors, not transient.
  if (res.status === 404 || res.status === 422 || res.status === 409) {
    return {
      ok: false,
      transient: false,
      message: `commitHash ${commitHash} was not found in ${owner}/${repo}. Confirm the commit is pushed to the public repo and the hash is correct.`,
    };
  }
  if (res.status === 403 || res.status === 429) {
    return { ok: false, transient: true, message: `GitHub API rate limit or access error (HTTP ${res.status}).` };
  }
  return { ok: false, transient: true, message: `Unexpected GitHub API response (HTTP ${res.status}).` };
}

function annotateError(file, message) {
  console.log(`::error file=${file}::${message}`);
}

function annotateWarning(file, message) {
  console.log(`::warning file=${file}::${message}`);
}

async function main() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  // Files flagged as changed by the workflow get the online commit check.
  const changed = new Set(
    (process.env.CHANGED_FILES || "")
      .split(/\s+/)
      .map((f) => f.trim())
      .filter(Boolean)
      .map((f) => f.replace(/^\.\//, "")),
  );

  const files = fs
    .readdirSync(MODS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  let failed = false;

  for (const file of files) {
    const relPath = `mods/${file}`;
    const expectedId = file.replace(/\.json$/, "");
    const fullPath = path.join(MODS_DIR, file);

    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
    } catch (err) {
      annotateError(relPath, `Invalid JSON: ${err.message}`);
      failed = true;
      continue;
    }

    const schemaErrors = validateEntry(entry, expectedId);
    if (schemaErrors.length > 0) {
      for (const message of schemaErrors) {
        annotateError(relPath, message);
      }
      failed = true;
      // Skip the network check for entries that already failed schema.
      continue;
    }

    // Online commit verification, only for changed files.
    if (changed.has(relPath)) {
      const result = await verifyCommit(entry.repoUrl, entry.commitHash, token);
      if (result.ok) {
        console.log(`Verified ${relPath}: commit ${entry.commitHash} exists in ${entry.repoUrl}.`);
      } else if (result.transient) {
        annotateWarning(relPath, `Could not verify commitHash (treated as non-blocking): ${result.message}`);
      } else {
        annotateError(relPath, result.message);
        failed = true;
      }
    }
  }

  if (failed) {
    console.error("\nValidation failed. Fix the errors above and push again.");
    process.exitCode = 1;
    return;
  }
  console.log(`\nValidated ${files.length} mod file(s). All checks passed.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Validator crashed: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { validateEntry, verifyCommit };
