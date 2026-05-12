# Douyin Playwright Outreach

Codex skill and Playwright controller for finding Douyin creators and sending only user-approved business cooperation DMs through the official Douyin web UI.

This project is intentionally conservative. It does not bypass login, CAPTCHA, SMS verification, slider checks, account-risk prompts, rate limits, privacy restrictions, or Douyin platform controls. A visible Chrome window is used by default so the account owner can complete required verification manually.

## What It Does

- Probes the current Douyin web UI and records selector signals.
- Searches creator/user results by one or more keywords.
- Collects candidate rows with profile URLs, names, fan counts when visible, and raw text for review.
- Sends DMs only from an approved JSON file or approved message input.
- Verifies send results from the rendered conversation, including common web failure states.

## Requirements

- Node.js 18 or newer.
- Google Chrome installed locally.
- A Douyin account that you are authorized to use.
- Manual access to complete QR login, SMS verification, CAPTCHA, or slider checks when Douyin asks.

## Installation

```bash
git clone <your-repo-url> douyin-playwright-outreach
cd douyin-playwright-outreach
npm install
```

If Playwright asks to install browsers, this skill normally uses your system Chrome with `channel: chrome`, so a separate Chromium download is usually not required.

## Quick Start

Run a probe first. Douyin changes its web markup often, so do not assume old selectors still work.

```bash
npm run probe -- --keyword "美食博主"
```

Search creators:

```bash
npm run search -- \
  --keywords "美食博主,探店博主,餐饮博主" \
  --min-fans 200000 \
  --target-count 20 \
  --out /tmp/douyin-candidates.json
```

Review `/tmp/douyin-candidates.json`, choose the rows you want to contact, and create an approved input file:

```json
{
  "approved_message": "您好，我们正在寻找美食探店方向的内容合作伙伴，想了解一下贵账号近期商务合作档期和报价，方便的话可以发一份合作资料吗？",
  "rows": [
    {
      "creator_name": "示例博主",
      "profile_url": "https://www.douyin.com/user/REPLACE_WITH_REAL_PROFILE_URL",
      "fans": 250000
    }
  ]
}
```

Send approved rows:

```bash
npm run send -- \
  --input /tmp/douyin-approved.json \
  --max-send 10 \
  --out /tmp/douyin-send-results.json
```

## Commands

### `probe`

Opens Douyin, inspects search inputs and useful `data-e2e` values, then tries a keyword search.

```bash
npm run probe -- --keyword "美食博主"
```

Useful options:

- `--keyword <text>`: keyword to test.
- `--user-data-dir <path>`: persistent Chrome profile path.
- `--login-timeout-ms <ms>`: wait time for manual login or verification. Default: `300000`.
- `--manual-auth-poll-ms <ms>`: read-only polling interval while the user is completing login or verification. Default: `5000`.
- `--manual-auth-stable-checks <number>`: number of consecutive clear checks required before automation resumes. Default: `3`.
- `--post-auth-wait-ms <ms>`: short wait after login/verification disappears before retrying. Default: `1200`.
- `--post-auth-retry-wait-ms <ms>`: short wait after reloading/retrying the original action. Default: `1800`.
- `--no-wait-login`: stop immediately on login or verification UI. Useful for debugging only.
- `--headless`: run headless. Not recommended for real Douyin sessions.

### `search`

Searches creator/user results and writes candidate rows.

```bash
npm run search -- --keyword "美食博主" --min-fans 200000 --max-results 20 --out /tmp/candidates.json
```

Useful options:

- `--keyword <text>`: one keyword.
- `--keywords "a,b,c"`: sequential multi-keyword search.
- `--min-fans <number>`: minimum visible fan count. Rows without fan counts are kept as `needs_review_no_fan_count`.
- `--max-results <number>`: maximum rows to collect per search pass. Default: `30`.
- `--target-count <number>`: total deduplicated rows to return across keywords.
- `--scrolls <number>`: maximum result-page scroll attempts. Default: `10`.
- `--stable-scrolls <number>`: stop after this many scrolls with no new rows. Default: `3`.
- `--direct-only`: use direct user-search URLs only, without header-search fallback.
- `--out <path>`: write JSON output to a file.

### `send`

Sends only approved rows from a JSON file.

```bash
npm run send -- --input /tmp/douyin-approved.json --max-send 10 --out /tmp/results.json
```

Useful options:

- `--input <path>`: approved JSON file. Required.
- `--message <text>`: fallback message if the input file does not include `approved_message`.
- `--max-send <number>`: maximum rows to send in this run. Default: `10`.
- `--verify-draft`: verify every draft before sending. The first row is always verified.
- `--dm-click-attempts <number>`: automatic retries for the profile-level `私信` button. Default: `4`.
- `--manual-dm-timeout-ms <ms>`: wait time for manual DM-window opening when automatic clicks fail. Default: `180000`.
- `--no-wait-manual-dm`: do not wait for manual DM-window opening. Debugging only.
- `--send-check-wait-ms <ms>`: wait before checking rendered send result. Default: `3000`.
- `--out <path>`: write JSON output to a file.

## JSON Formats

Search output:

```json
{
  "command": "search",
  "keywords": ["美食博主"],
  "min_fans": 200000,
  "target_count": 20,
  "count": 1,
  "candidates": [
    {
      "creator_name": "示例博主",
      "profile_url": "https://www.douyin.com/user/...",
      "raw_text": "页面可见文本片段",
      "raw_fans": "25万",
      "fans": 250000,
      "status": "candidate"
    }
  ]
}
```

Approved send input:

```json
{
  "approved_message": "您好，想沟通一下近期商务合作...",
  "rows": [
    {
      "creator_name": "示例博主",
      "profile_url": "https://www.douyin.com/user/...",
      "fans": 250000
    }
  ]
}
```

Send output:

```json
{
  "command": "send",
  "input": "/tmp/douyin-approved.json",
  "results": [
    {
      "creator_name": "示例博主",
      "profile_url": "https://www.douyin.com/user/...",
      "status": "sent"
    }
  ]
}
```

Common send statuses:

- `sent`: message appeared in the rendered conversation with no nearby failure signal.
- `failed_web_send`: Douyin showed a visible failure signal such as send failure, retry, or delivery failure.
- `send_unconfirmed`: the script could not confirm the final state.
- `failed_dm_button_unavailable`: no usable profile-level DM entry was found.
- `failed_editor_unavailable`: DM opened but no editor was detected.
- `failed_draft_mismatch`: editor content did not match the approved message.
- `stopped_manual_auth_timeout`: login or verification was not completed within the configured timeout.
- `stopped_risk`: Douyin showed an account-risk, rate-limit, or restriction state.

## Safe Operating Rules

- Do not run unsupervised mass-DM workflows.
- Review candidate rows before sending.
- Send only approved rows and exact approved text.
- Keep the default first-contact cap at 10 or lower unless you have a stronger platform-safe process.
- Stop on rate limits, repeated operation warnings, account abnormality, platform restrictions, or unclear recipient/editor state.
- When login, QR scan, SMS, CAPTCHA, or slider verification appears, complete it manually in the visible Chrome window. During this pause, the script does not click, type, scroll, or reload. It resumes only after the verification state is gone for several consecutive read-only checks, then retries the original action.
- Use keyboard-equivalent input for messages. Do not mutate Douyin DOM or framework state directly.
- Do not run parallel searches or sends with the same `--user-data-dir`; Chrome persistent profiles are single-owner.

## Chrome Profile

By default, the script uses:

```text
~/.douyin-playwright-profile
```

For tests, use a temporary profile:

```bash
npm run probe -- --keyword "美食博主" --user-data-dir /tmp/douyin-playwright-profile
```

Do not commit Chrome profile directories. They may contain cookies, session data, browsing history, and local account state.

## Codex Skill Usage

This repository can be used as a Codex skill by placing it under:

```text
~/.codex/skills/douyin-playwright-outreach
```

Then ask Codex to use `$douyin-playwright-outreach` for Douyin creator search or approved outreach. The operational instructions live in `SKILL.md`.

## Maintenance

Douyin selectors and page flows change frequently. When behavior changes:

1. Run `npm run probe -- --keyword "<current niche keyword>"`.
2. Inspect returned `dataE2E`, input, body text, and URLs.
3. Update `scripts/douyin_playwright_outreach.js`.
4. Record confirmed findings in `references/current-douyin-web.md`.
5. Run syntax validation:

```bash
npm run check
```

## Legal And Platform Notice

This tool automates a logged-in user's visible browser session on Douyin's official web UI. You are responsible for complying with Douyin's terms, applicable laws, advertising and marketing rules, privacy rules, and recipient consent requirements. This project does not provide or endorse scraping private data, bypassing access controls, spam, or account-risk evasion.
