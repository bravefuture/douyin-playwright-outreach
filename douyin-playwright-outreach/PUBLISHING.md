# Publishing Checklist

Use this checklist before pushing the skill to GitHub.

## Files To Commit

Commit these files and directories:

- `SKILL.md`
- `README.md`
- `PUBLISHING.md`
- `package.json`
- `package-lock.json`
- `.gitignore`
- `agents/`
- `examples/`
- `references/`
- `scripts/`

## Files Not To Commit

Do not commit these:

- `node_modules/`
- `profile/`
- any Chrome user-data directory
- real candidate, approved, or send-result JSON files
- screenshots, logs, cookies, browser history, or account session files

The included `.gitignore` is set up for this, but check manually before publishing.

## Recommended First Publish Flow

From the skill directory:

```bash
git init
git status --short
npm run check
git add SKILL.md README.md PUBLISHING.md package.json package-lock.json .gitignore agents examples references scripts
git status --short
git commit -m "Initial douyin playwright outreach skill"
git branch -M main
git remote add origin <your-github-repo-url>
git push -u origin main
```

Before `git commit`, confirm that `git status --short` does not show `node_modules/` or `profile/`.

## After Cloning On Another Machine

```bash
npm install
npm run check
npm run probe -- --keyword "美食博主" --user-data-dir /tmp/douyin-playwright-profile
```

Use a temporary `--user-data-dir` first. Switch to a durable profile path only after the operator understands where login/session data will be stored.

## GitHub Repository Notes

Suggested repository description:

```text
Codex skill and Playwright controller for approved Douyin creator outreach through the official web UI.
```

Suggested topics:

```text
codex-skill, playwright, douyin, creator-outreach
```

Do not publish real outreach lists, real message logs, or authenticated browser profiles as examples.
