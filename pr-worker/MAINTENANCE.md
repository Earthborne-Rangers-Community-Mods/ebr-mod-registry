# Cloudflare Worker Maintenance - `ebr-mod-pr`

This worker creates registry PRs on the user's behalf via a GitHub App, so `ebr publish` does not have to open a browser. Deployed at `https://ebr-mod-pr.ebr-mods.workers.dev`.

The CLI calls `POST /create-pr` after pushing the mod entry to the user's registry fork. The request carries the user's GitHub token; the worker verifies the token's login matches `forkOwner` before opening the PR, so a caller cannot open PRs from someone else's fork. If the worker is unreachable, `ebr publish` falls back to the browser compare-URL flow, so publishing still works without this worker.

---

## Configuration

| Name | Type | Purpose |
|------|------|---------|
| `APP_ID` | var or secret | GitHub App ID (EBR Mod Registry Bot, `3494042`). |
| `INSTALLATION_ID` | var or secret | App installation ID (`126835599`). |
| `PRIVATE_KEY` | secret | GitHub App private key (PKCS8 PEM). |
| `REGISTRY_OWNER` | var | Upstream registry owner. |
| `REGISTRY_REPO` | var | Upstream registry repo. |
| `ALLOWED_ORIGIN` | var | CORS origin. `*` is fine; the CLI is not browser-bound. |
| `RATE_LIMIT` | KV (optional) | Per-fork-owner request budget. Skipped when not bound. |

The PR endpoint sets `maintainer_can_modify: false` - required to avoid a 422 `fork_collab` error when an installation token opens a cross-fork PR.

---

## Set the private key secret

The GitHub App key downloads as a `.pem`. PKCS1 (`BEGIN RSA PRIVATE KEY`) and
PKCS8 (`BEGIN PRIVATE KEY`) are both accepted - the worker converts PKCS1 to
PKCS8 at runtime. Pipe the file so every line is stored; pasting at the
interactive prompt often captures only the first line, which silently breaks
the key:

```
Get-Content app.private-key.pem -Raw | npx wrangler secret put PRIVATE_KEY
```

(`-Raw` preserves the newlines.) Then set the App and installation IDs:

```
npx wrangler secret put APP_ID
npx wrangler secret put INSTALLATION_ID
```

(or leave them as `vars` in `wrangler.jsonc` if you prefer them non-secret.)

---

## Optional rate-limit KV

```
npx wrangler kv namespace create RATE_LIMIT
```

Add the returned binding to `wrangler.jsonc` under `kv_namespaces`. The worker
allows 10 PRs per fork owner per 10 minutes; without the binding, rate limiting
is skipped.

---

## Deploy

```
npx wrangler deploy
```

---

## Local development

```
npx wrangler dev --port 8788
```

`wrangler dev` does NOT inject production secrets - add a `.dev.vars`:

```
APP_ID=3494042
INSTALLATION_ID=126835599
PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

`.dev.vars` is gitignored. Never commit it.

---

## Smoke test

```
curl -X POST https://ebr-mod-pr.ebr-mods.workers.dev/create-pr -H "Content-Type: application/json" -H "Authorization: Bearer <your-pat>" -d "{\"forkOwner\":\"SunberryKeeper\",\"branch\":\"publish/test-mod\",\"title\":\"New mod: Test\"}"
```

201 with `{number,url}` on success; 401 without a token; 403 if the token owner does not match forkOwner; 404 if the fork branch is missing; 409 if a PR already exists. PRs always target `main`.
