# Cellardoor Daily

This repository hosts the public daily briefing JSON that the Cellardoor iOS app reads.

The app reads:

```text
https://raw.githubusercontent.com/hsemara/cellardoor-daily/refs/heads/main/latest-briefing-ai.json
```

## Daily Publishing

GitHub Actions runs `Publish daily briefing` every morning at 6:05 AM Pacific during daylight time.

The workflow:

1. Fetches recent posts from curated public X accounts.
2. Generates a Cellardoor briefing with OpenAI.
3. Writes `latest-briefing-ai.json`.
4. Archives the dated file as `ai-briefing-YYYY-MM-DD.json`.
5. Commits the update to `main`.

## Required Secrets

In GitHub, open this repository and go to:

```text
Settings -> Secrets and variables -> Actions -> Repository secrets
```

Add:

```text
X_BEARER_TOKEN
OPENAI_API_KEY
```

Optional repository variable:

```text
OPENAI_MODEL
```

If `OPENAI_MODEL` is not set, the workflow uses `gpt-5.4-mini`.

## Manual Run

Open:

```text
Actions -> Publish daily briefing -> Run workflow
```

The iOS app checks the hosted JSON when it launches and when it returns to the foreground. GitHub raw URLs may cache for a few minutes, so the app can lag behind the commit briefly.
