# Post-Mortem: Bot Silently Dropped All Reviews (PKCS#1 / OpenSSL 3)

**Date:** 2026-04-26  
**Duration:** ~2 days from first deploy to fix  
**Severity:** Total loss of review output — bot accepted every webhook but posted no reviews

---

## What Happened

The bot was deployed to Vercel, configured, and triggered repeatedly via `/ai-review` comments on a test PR. Every GitHub delivery showed HTTP 202, so the bot appeared healthy. No reviews ever appeared on the PR.

## Timeline

| Time (UTC) | Event |
| --- | --- |
| 2026-04-24 | Initial deploy. Reviews not appearing. First assumed `REVIEW_ENABLED` was unset. |
| 2026-04-25 | Fire-and-forget async pattern adopted. Still no reviews. Suspected Vercel was killing the function after response. |
| 2026-04-25 | Switched to `waitUntil` from `@vercel/functions`. GitHub delivery history confirmed 202s. Still no reviews. |
| 2026-04-26 | Added diagnostic logs. Pulled full Vercel function logs — `--no-branch` flag required. Found `ERR_OSSL_UNSUPPORTED` error. |
| 2026-04-26 | Converted private key from PKCS#1 to PKCS#8. Updated Vercel env var. Redeployed. First review posted. |

## Root Cause

GitHub App private keys are issued in **PKCS#1 format** (`-----BEGIN RSA PRIVATE KEY-----`). Vercel's production runtime uses **Node.js 20 with OpenSSL 3**.

The `universal-github-app-jwt` package (a dependency of `octokit`) detects PKCS#1 keys and tries to convert them to PKCS#8 at JWT-signing time using Node's `createPrivateKey`:

```js
// universal-github-app-jwt/lib/crypto-node.js
export function convertPrivateKey(privateKey) {
  if (!isPkcs1(privateKey)) return privateKey;
  return createPrivateKey(privateKey).export({ type: "pkcs8", format: "pem" });
}
```

OpenSSL 3 raises `ERR_OSSL_UNSUPPORTED` when `createPrivateKey` attempts to load the PKCS#1 key — before the conversion can even run.

## Why It Was Hard to Find

Three factors delayed diagnosis:

1. **Webhook signature verification uses HMAC-SHA256, not the private key.** The bot passed signature checks and returned 202 on every delivery, appearing fully functional in GitHub's delivery history.

2. **The real error was async.** `waitUntil` defers processing after the HTTP response. The `ERR_OSSL_UNSUPPORTED` only surfaced when `getInstallationOctokit()` was called — well after the 202 was logged — so it never appeared in naive log checks.

3. **`vercel logs` defaults to branch-filtered output.** Running `vercel logs --environment production` returned "No logs found" because of an implicit branch filter. The `--no-branch` flag is required to see logs across all deployments. This masked the error for multiple sessions.

## Fix

Convert the private key to PKCS#8 before storing it in any environment:

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in your-app.private-key.pem \
  -out your-app.private-key.pkcs8.pem
```

The resulting file starts with `-----BEGIN PRIVATE KEY-----` (no `RSA`). Use this value in `GITHUB_APP_PRIVATE_KEY`. The `normalizePrivateKey` function in `config.ts` requires no changes — it only handles `\n` escaping, which is unaffected by key format.

## What to Check on Any New Deployment

```bash
# 1. Confirm env vars are present and REVIEW_ENABLED is true
curl https://your-app.vercel.app/api/debug

# 2. Pull full logs — MUST use --no-branch
vercel logs --no-branch --since 10m --no-follow --expand

# 3. Confirm the private key is PKCS#8 (not PKCS#1)
head -1 your-key.pem   # must be "-----BEGIN PRIVATE KEY-----", not "BEGIN RSA PRIVATE KEY"
```

## Prevention

- **Store only PKCS#8 keys.** Convert immediately after downloading from GitHub App settings. The PKCS#1 key GitHub provides is not usable on Node.js 20+ / OpenSSL 3.
- **Add a startup key-format check** in `config.ts` — if the private key contains `BEGIN RSA PRIVATE KEY`, throw at boot rather than failing silently mid-request.
- **Always use `--no-branch` when streaming Vercel logs** for production debugging.
