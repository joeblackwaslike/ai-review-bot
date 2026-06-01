# Quick Start

Get parallel AI code reviews from both Claude and Codex in under 15 minutes.

## Prerequisites

- A GitHub account with permission to create GitHub Apps
- A [Vercel](https://vercel.com) account (free tier works)
- An [Anthropic](https://console.anthropic.com) API key (for the Claude bot)
- An [OpenAI](https://platform.openai.com) API key (for the Codex bot)

You can set up just one bot if you only want one provider — skip the sections for the other.

## Step 1 — Create the Claude GitHub App

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App**
2. Set the app name (e.g. `my-claude-reviewer`)
3. Set **Webhook URL** to a placeholder for now (`https://example.com`) — you'll update this after deploy
4. Set **Webhook secret** to a random string — save it, you'll need it as `GITHUB_WEBHOOK_SECRET`
5. Grant these permissions:
   - **Pull requests**: Read and write
   - **Contents**: Read-only
   - **Metadata**: Read-only
   - **Issues**: Read-only
6. Subscribe to these events:
   - **Pull request**
   - **Issue comment**
7. Click **Create GitHub App**
8. Note the **App ID** shown at the top of the settings page — this is `GITHUB_APP_ID`
9. Scroll to **Private keys** and click **Generate a private key** — save the `.pem` file

## Step 2 — Create the Codex GitHub App

Repeat Step 1 with a different app name (e.g. `my-codex-reviewer`). The permissions and events are identical. Save the values as:

- App ID → `OPENAI_APP_ID`
- Webhook secret → `OPENAI_APP_WEBHOOK_SECRET`
- Private key → a separate `.pem` file

## Step 3 — Format your private keys

Vercel stores secrets as single-line strings. Convert each PEM to a one-liner:

```bash
awk 'NF {printf "%s\\n", $0}' claude-private-key.pem   # → GITHUB_APP_PRIVATE_KEY
awk 'NF {printf "%s\\n", $0}' codex-private-key.pem    # → OPENAI_APP_PRIVATE_KEY
```

> **Important:** The key must be in PKCS#8 format (header reads `BEGIN PRIVATE KEY`). If your key says `BEGIN RSA PRIVATE KEY` (PKCS#1), convert it first:
>
> ```bash
> openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key.pkcs8.pem
> ```

## Step 4 — Deploy to Vercel

**Option A — Vercel dashboard:**

1. Fork this repo on GitHub
2. Go to [vercel.com/new](https://vercel.com/new) and import your fork
3. Set framework preset to **Other**
4. Add environment variables for both bots:

```env
# Claude bot
GITHUB_APP_ID=<your Claude app ID>
GITHUB_APP_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----
GITHUB_WEBHOOK_SECRET=<your Claude webhook secret>
ANTHROPIC_API_KEY=sk-ant-...

# Codex bot
OPENAI_APP_ID=<your Codex app ID>
OPENAI_APP_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----
OPENAI_APP_WEBHOOK_SECRET=<your Codex webhook secret>
OPENAI_API_KEY=sk-...

# Shared
REVIEW_ENABLED=true
```

1. Click **Deploy** and copy the production URL

**Option B — Vercel CLI:**

```bash
git clone https://github.com/joeblackwaslike/ai-review-bot.git
cd ai-review-bot
vercel link

# Claude bot
vercel env add GITHUB_APP_ID
vercel env add GITHUB_APP_PRIVATE_KEY
vercel env add GITHUB_WEBHOOK_SECRET
vercel env add ANTHROPIC_API_KEY

# Codex bot
vercel env add OPENAI_APP_ID
vercel env add OPENAI_APP_PRIVATE_KEY
vercel env add OPENAI_APP_WEBHOOK_SECRET
vercel env add OPENAI_API_KEY

# Shared
vercel env add REVIEW_ENABLED   # value: true

vercel --prod
```

## Step 5 — Point each webhook at its endpoint

The two bots use different webhook endpoints. In each GitHub App's settings, update the **Webhook URL**:

| App | Webhook URL |
| --- | --- |
| Claude bot | `https://your-deployment.vercel.app/api/github/webhook` |
| Codex bot | `https://your-deployment.vercel.app/api/github/webhook-openai` |

Save changes. GitHub will send a ping event to each — check your Vercel function logs to confirm they arrive.

## Step 6 — Install both apps on your repos

For each GitHub App:

1. In the app settings, click **Install App**
2. Select the repositories you want reviewed

That's it. Reviews are **automatic by default** — both bots will post a review on every pull request opened or pushed to in the installed repos. No further action needed; the next PR you open will receive two parallel reviews.

## Triggering a review manually

The slash command is for cases where the automatic review didn't run or you want to re-review:

- The PR was already open before you installed the apps
- The auto-review fired but you want a fresh look after more changes
- You want to re-run with extra instructions

Comment on any PR in an installed repo:

```text
/ai-review
```

Both bots respond to the same command. You'll see two reviews appear — one from the Claude bot and one from the Codex bot, each with its own icon.

```text
/ai-review focus on the auth layer    # with extra instructions
/ai-review --force                    # re-review the same commit
```

## Verification

After your first reviews post, check:

- **`GET /api/health`** — returns `{ "status": "ok" }`
- **`GET /api/debug`** — returns current config (API keys masked)
- **Vercel function logs** — look for `agent results collected` and `merged review` log lines for both bots

## Local development

Use [smee.io](https://smee.io) to receive webhooks locally. Create two channels — one per bot:

```bash
# Terminal 1 — Claude bot proxy
npx smee-client --url https://smee.io/<channel-1> \
  --target http://localhost:3000/api/github/webhook

# Terminal 2 — Codex bot proxy
npx smee-client --url https://smee.io/<channel-2> \
  --target http://localhost:3000/api/github/webhook-openai

# Terminal 3 — local server
cp .env.example .env   # fill in your values
npm run dev
```

Point each GitHub App's Webhook URL at its respective smee channel URL during development, then switch back to the Vercel URLs when you deploy.
