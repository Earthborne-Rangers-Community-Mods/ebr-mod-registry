import githubAppJwt from 'universal-github-app-jwt';
import forge from 'node-forge';

export interface Env {
	APP_ID: string;
	INSTALLATION_ID: string;
	PRIVATE_KEY: string;
	REGISTRY_OWNER: string;
	REGISTRY_REPO: string;
	ALLOWED_ORIGIN: string;
	RATE_LIMIT?: KVNamespace;
}

// Fork owner: GitHub login chars (alphanumeric + hyphen).
const OWNER_RE = /^[A-Za-z0-9-]{1,39}$/;
// Branch: only the publish branches the CLI creates.
const BRANCH_RE = /^publish\/[A-Za-z0-9._-]{1,80}$/;

// Per-owner request budget within the window (used only if RATE_LIMIT is bound).
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_SECONDS = 600;

interface CreatePrBody {
	forkOwner?: string;
	branch?: string;
	title?: string;
	body?: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'OPTIONS') {
			return cors(null, 204, env.ALLOWED_ORIGIN);
		}
		if (request.method !== 'POST' || url.pathname !== '/create-pr') {
			return cors(JSON.stringify({ error: 'Not found' }), 404, env.ALLOWED_ORIGIN);
		}

		let payload: CreatePrBody;
		try {
			payload = (await request.json()) as CreatePrBody;
		} catch {
			return cors(JSON.stringify({ error: 'Invalid JSON body' }), 400, env.ALLOWED_ORIGIN);
		}

		const forkOwner = payload.forkOwner?.trim();
		const branch = payload.branch?.trim();
		// Base is always the registry's main branch; the API does not expose it.
		const base = 'main';
		const title = payload.title?.trim();
		const body = payload.body ?? '';

		if (!forkOwner || !OWNER_RE.test(forkOwner)) {
			return cors(JSON.stringify({ error: 'Invalid forkOwner' }), 400, env.ALLOWED_ORIGIN);
		}
		if (!branch || !BRANCH_RE.test(branch)) {
			return cors(JSON.stringify({ error: 'Invalid branch' }), 400, env.ALLOWED_ORIGIN);
		}
		if (!title) {
			return cors(JSON.stringify({ error: 'Missing title' }), 400, env.ALLOWED_ORIGIN);
		}

		// Caller authentication: the request must carry the user's GitHub token,
		// and its login must equal forkOwner. Without this an anonymous caller who
		// guessed another user's publish/* branch could open a PR in their name.
		const callerToken = bearerToken(request);
		const caller = callerToken ? await loginForToken(callerToken) : null;
		if (!callerToken || !caller) {
			return cors(JSON.stringify({ error: 'Missing or invalid GitHub token' }), 401, env.ALLOWED_ORIGIN);
		}
		if (caller.toLowerCase() !== forkOwner.toLowerCase()) {
			return cors(JSON.stringify({ error: 'Token owner does not match forkOwner' }), 403, env.ALLOWED_ORIGIN);
		}

		// Rate-limit per fork owner if a KV namespace is bound.
		if (env.RATE_LIMIT) {
			const limited = await isRateLimited(env.RATE_LIMIT, forkOwner);
			if (limited) {
				return cors(JSON.stringify({ error: 'Rate limit exceeded. Try again later.' }), 429, env.ALLOWED_ORIGIN);
			}
		}

		let installToken: string;
		try {
			installToken = await getInstallationToken(env);
		} catch (err) {
			return cors(JSON.stringify({ error: `Auth failed: ${(err as Error).message}` }), 502, env.ALLOWED_ORIGIN);
		}

		// Verify the fork branch exists before opening a PR. This confirms the
		// branch lives in the named fork, so the head ref cannot be spoofed onto
		// another account's fork.
		const branchOk = await branchExists(callerToken, forkOwner, env.REGISTRY_REPO, branch);
		if (!branchOk) {
			return cors(JSON.stringify({ error: 'Fork branch not found' }), 404, env.ALLOWED_ORIGIN);
		}

		// Cross-fork PR. maintainer_can_modify MUST be false: GitHub returns a
		// 422 fork_collab error otherwise when an installation token opens a PR
		// from a fork it cannot push to.
		const head = `${forkOwner}:${branch}`;
		const prRes = await fetch(`https://api.github.com/repos/${env.REGISTRY_OWNER}/${env.REGISTRY_REPO}/pulls`, {
			method: 'POST',
			headers: ghHeaders(installToken),
			body: JSON.stringify({ title, body, head, base, maintainer_can_modify: false }),
		});

		if (prRes.status === 201) {
			const pr = (await prRes.json()) as { number: number; html_url: string };
			return cors(JSON.stringify({ number: pr.number, url: pr.html_url }), 201, env.ALLOWED_ORIGIN);
		}

		// 422 with an "already exists" message means a PR is already open for this
		// head/base. Surface it so the CLI can report the existing one.
		const detail = await prRes.text();
		if (prRes.status === 422 && /already exist/i.test(detail)) {
			return cors(JSON.stringify({ error: 'A pull request already exists for this branch' }), 409, env.ALLOWED_ORIGIN);
		}
		return cors(JSON.stringify({ error: `GitHub PR creation failed: ${prRes.status}` }), 502, env.ALLOWED_ORIGIN);
	},
};

function ghHeaders(token: string): HeadersInit {
	return {
		Accept: 'application/vnd.github+json',
		Authorization: `Bearer ${token}`,
		'User-Agent': 'ebr-mod-pr/1.0',
		'X-GitHub-Api-Version': '2022-11-28',
		'Content-Type': 'application/json',
	};
}

// Resolve the GitHub login of the caller's token, or null if absent/invalid.
function bearerToken(request: Request): string | null {
	const auth = request.headers.get('Authorization');
	const token = auth?.replace(/^(token|Bearer)\s+/i, '').trim();
	return token || null;
}

async function loginForToken(token: string): Promise<string | null> {
	let res: Response;
	try {
		res = await fetch('https://api.github.com/user', {
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${token}`,
				'User-Agent': 'ebr-mod-pr/1.0',
				'X-GitHub-Api-Version': '2022-11-28',
			},
		});
	} catch {
		return null;
	}
	if (res.status !== 200) return null;
	const data = (await res.json()) as { login?: string };
	return data.login ?? null;
}

async function branchExists(token: string, owner: string, repo: string, branch: string): Promise<boolean> {
	const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`, {
		headers: ghHeaders(token),
	});
	return res.status === 200;
}

async function isRateLimited(kv: KVNamespace, owner: string): Promise<boolean> {
	const key = `pr:${owner}`;
	const current = parseInt((await kv.get(key)) ?? '0', 10);
	if (current >= RATE_LIMIT_MAX) return true;
	await kv.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
	return false;
}

// --- GitHub App auth ---

// WebCrypto (and thus universal-github-app-jwt) only accepts PKCS#8
// ("BEGIN PRIVATE KEY"). GitHub issues PKCS#1 keys ("BEGIN RSA PRIVATE KEY"),
// so re-encode those as PKCS#8 via node-forge. PKCS#8 keys pass through.
function toPkcs8(privateKey: string): string {
	if (!privateKey.includes('BEGIN RSA PRIVATE KEY')) return privateKey;
	const rsa = forge.pki.privateKeyFromPem(privateKey);
	return forge.pki.privateKeyInfoToPem(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(rsa)));
}

async function getInstallationToken(env: Env): Promise<string> {
	const { token: jwt } = await githubAppJwt({ id: env.APP_ID, privateKey: toPkcs8(env.PRIVATE_KEY) });
	const res = await fetch(`https://api.github.com/app/installations/${env.INSTALLATION_ID}/access_tokens`, {
		method: 'POST',
		headers: {
			Accept: 'application/vnd.github+json',
			Authorization: `Bearer ${jwt}`,
			'User-Agent': 'ebr-mod-pr/1.0',
			'X-GitHub-Api-Version': '2022-11-28',
		},
	});
	if (res.status !== 201) {
		throw new Error(`installation token ${res.status}`);
	}
	const data = (await res.json()) as { token: string };
	return data.token;
}

function cors(body: string | null, status: number, allowedOrigin: string): Response {
	return new Response(body, {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': allowedOrigin,
			'Access-Control-Allow-Methods': 'POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		},
	});
}
