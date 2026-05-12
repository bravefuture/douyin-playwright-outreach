---
name: douyin-playwright-outreach
description: Search Douyin creators and operate approved business-cooperation private messages through the official Douyin web UI using Playwright, not Chrome DevTools MCP. Use when Codex needs to validate current Douyin web selectors, search creators by keyword, collect profile candidates and fan counts, prepare outreach rows, send user-approved DMs, or build/adjust Playwright automation for Douyin creator outreach.
---

# Douyin Playwright Outreach

This skill is paired with the repository README. Use `README.md` for installation, command reference, JSON examples, and GitHub-facing user documentation. Use this `SKILL.md` as the operational policy for Codex runs.

## Core Rules

Use Playwright as the browser automation layer. Do not use Chrome DevTools MCP for this skill unless the user explicitly overrides the requirement.

Operate only inside the official Douyin web UI (`https://www.douyin.com/`). Do not bypass login, CAPTCHA, slider verification, SMS checks, rate limits, privacy restrictions, or account risk prompts. If login, QR scan, SMS code, CAPTCHA, slider, or verification UI appears in a visible Playwright Chrome window, keep the browser open and wait for the user to complete it manually before continuing. Stop only for hard risk states such as account abnormality, rate limits, repeated operation warnings, platform send restrictions, or if manual login/verification times out.

Do not run an unsupervised mass-DM workflow. Search and collect candidate rows first, show the rows and exact message text, then send only after the user approves the target range and message. Default to a conservative daily first-contact cap of 10 unless the user sets a lower cap or Douyin shows a limit.

## Quick Start

Use the bundled Playwright controller when possible. If the user is setting up the project for the first time, direct them to `README.md` first.

```bash
cd ~/.codex/skills/douyin-playwright-outreach
npm install
npm run probe -- --keyword "美食博主"
npm run search -- --keyword "美食博主" --min-fans 200000 --max-results 20 --out /tmp/douyin-candidates.json
npm run search -- --keywords "美食博主,探店博主,餐饮博主" --min-fans 200000 --target-count 20 --out /tmp/douyin-candidates.json
npm run send -- --input /tmp/douyin-approved.json --max-send 10
```

Playwright is installed as this skill's local dependency. If `node_modules` is removed, reinstall it in the skill directory:

```bash
cd ~/.codex/skills/douyin-playwright-outreach
npm install playwright
```

The script launches a persistent visible Chrome context by default so the user can log in once and reuse the session. It defaults to `~/.douyin-playwright-profile`. Prefer `--user-data-dir /tmp/douyin-playwright-profile` for testing, or a user-approved durable profile path for repeated work. Never commit Chrome profile directories.

When login or verification appears, the script waits up to 5 minutes by default for the user to finish it in the visible browser. During this manual-auth pause, the script must not click, type, scroll, or reload the page; it only performs low-frequency read-only checks. After the manual state is gone for several consecutive checks, it waits briefly, then automatically retries the original action: the same search keyword, the same creator profile load, or the same DM-open flow. Use `--login-timeout-ms 600000` for a longer wait, `--manual-auth-poll-ms`, `--manual-auth-stable-checks`, `--post-auth-wait-ms`, and `--post-auth-retry-wait-ms` to tune retry timing, or `--no-wait-login` only when diagnosing page state and you want an immediate stop.

When sending, Douyin may ignore Playwright's click on a profile-level `私信` button even though manual clicking works. After any login/verification completes, the script must reload the same creator profile and automatically retry the profile-level `私信` click before asking for manual help. Use `--dm-click-attempts 4` to control automatic retries. Only if those retries still fail should the script keep the browser open and wait for the user to manually open the chat window, then resume once it detects the message editor. Use `--manual-dm-timeout-ms 300000` for a longer wait, or `--no-wait-manual-dm` only when diagnosing click behavior.

After sending, do not treat a cleared editor or lack of immediate risk text as success. Wait 2-4 seconds by default (`--send-check-wait-ms 3000`), then inspect the rendered conversation for the sent text and nearby failure signals such as `发送失败`, `重新发送`, `重试`, `未送达`, red/error styling, or exclamation markers. Return `sent` only when the expected message appears and no failure signal is detected. Return `failed_web_send` when Web shows a send failure, and `send_unconfirmed` when the result cannot be confirmed.

## Workflow

1. Run `probe` first on the current day/session. Douyin changes selectors often; do not assume old selectors are valid.
2. If login or verification appears, keep the Playwright Chrome window open and wait while the user completes it manually. Do not interact with the page during this pause. Continue automatically only after the login/verification state is gone for consecutive checks, then retry the same target page/action before moving on. If the wait times out, report the visible state and ask the user to finish it before rerunning.
3. Run `search` to collect candidates. Derive search keywords from the user's requested category; do not hard-code a category in the skill. Prefer multi-keyword search with user/category-specific terms such as `--keywords "keyword1,keyword2,keyword3"` and `--target-count N`; the script searches keywords sequentially, enters user-result URLs directly, merges candidates, and deduplicates profile URLs. Do not run two searches at the same time with the same `--user-data-dir`; Chrome persistent profiles are single-owner and the second process can fail with `正在现有的浏览器会话中打开`.
4. Present candidates to the user and ask for approval of exact rows and exact message text.
5. Create an approved JSON file containing only approved rows and the exact `approved_message`.
6. Run `send` for the approved file. If login/verification appears during sending, wait for the user to complete it, reload the same creator profile, and automatically retry the profile-level `私信` click. If automatic retries still do not open the editor but the profile page is visible, wait for the user to manually open the chat window and then resume typing/sending from the detected editor. Stop on any platform challenge or unclear recipient/editor state. Treat creator-specific privacy/DM unavailable states as row failures and continue only when the next row is already approved.
7. Save the result log returned by the script and summarize sent, failed, skipped, and stopped rows.

## Current Selector Notes

On 2026-05-12, a read-only Playwright probe found:

- Homepage title: `抖音-记录美好生活`.
- Search input: `data-e2e="searchbar-input"` with placeholder `搜索你感兴趣的内容`.
- Header search button: `data-e2e="searchbar-button"`.
- `dy.py`'s old `input[placeholder="搜索"]` selector is stale.
- Unauthenticated homepage search may remain on `/jingxuan` and show a login panel instead of stable user results.
- Direct user-result URLs such as `/search/<keyword>?type=user` are more reliable than homepage search followed by tab switching. Use homepage search only as fallback.
- Search/user result selectors such as `[data-e2e="user-card"]` must be treated as opportunistic, not guaranteed.

When selectors fail, use visible text/roles and compact DOM reads before changing the script. Keep selector changes inside `scripts/douyin_playwright_outreach.js` and record confirmed findings in `references/current-douyin-web.md`.

## Message Safety

Use keyboard-equivalent text insertion for DM bodies. Do not insert message text by directly assigning DOM values or framework state. Clear the editor first, then use Playwright keyboard input or locator typing.

Before sending the first message in a session, verify that the editor preserves the first Chinese character. If `您好` becomes `好` or the draft is otherwise mutated, clear and retry once; if it still fails, skip or stop rather than repairing by cursor edits.

Never leave a DM editor focused while waiting for chat approval. If approval is still needed, move browser focus away from the editor and do not type any approval phrase into Douyin.

For send result reporting, use the rendered conversation as the source of truth. If the user's visible browser shows `发送失败`, override any earlier automation status and record `failed_web_send`.

## Resources

- `README.md`: GitHub-facing installation, usage, command reference, examples, and safety notes.
- `scripts/douyin_playwright_outreach.js`: Playwright controller for probing, searching, and sending approved rows.
- `references/current-douyin-web.md`: Selector findings and maintenance notes from live validation.
- `examples/`: Redacted example JSON files for candidate output, approved input, and send results.
