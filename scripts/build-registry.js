const fs = require("fs");
const path = require("path");

const MODS_DIR = path.resolve(__dirname, "..", "mods");
const OUTPUT = path.resolve(__dirname, "..", "registry.json");
const SCHEMA_VERSION = 1;

// Fields to include in the slim browse-tier registry.json
const BROWSE_FIELDS = [
  "id", "name", "author", "description", "repoUrl", "type",
  "tags", "campaigns", "requiredProducts",
  "safeToAddMidCampaign", "coverImage", "icon", "language",
  "latestVersion", "updatedAt", "commitHash",
];

const files = fs.readdirSync(MODS_DIR).filter(f => f.endsWith(".json"));

const mods = files.map(file => {
  const raw = fs.readFileSync(path.join(MODS_DIR, file), "utf-8");
  const full = JSON.parse(raw);
  const slim = {};
  for (const key of BROWSE_FIELDS) {
    if (full[key] !== undefined) {
      slim[key] = full[key];
    }
  }
  return slim;
});

// Sort alphabetically by id for stable output
mods.sort((a, b) => a.id.localeCompare(b.id));

const registry = { schemaVersion: SCHEMA_VERSION, mods };
fs.writeFileSync(OUTPUT, JSON.stringify(registry, null, 2) + "\n");
console.log(`Built registry.json with ${mods.length} mod(s).`);
