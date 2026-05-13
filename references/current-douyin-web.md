# Current Douyin Web Notes

Last verified: 2026-05-12 with Playwright Chromium using system Chrome.

## Probe Findings

- `https://www.douyin.com/` loads with title `抖音-记录美好生活`.
- The visible search input is an `INPUT` with:
  - `data-e2e="searchbar-input"`
  - `type="text"`
  - `placeholder="搜索你感兴趣的内容"`
- The header search button appears as `data-e2e="searchbar-button"`.
- Old code using `input[placeholder="搜索"]` should not be used as the only selector.
- On an unauthenticated or fresh context, entering a keyword and pressing Enter can leave the URL on `/jingxuan`, show search suggestions, and trigger login UI rather than loading stable creator results.
- The page currently includes header entries such as `data-e2e="im-entry"` for private messages and `data-e2e="notice-entry"` for notifications.
- A fresh headless persistent context can land on title `验证码中间页` or render the navigation without the search input. Default to visible Chrome (`headless: false`) for real work so the user can complete login/verification manually.
- Login, QR scan, SMS code, CAPTCHA, and slider pages are expected manual-auth states. Keep the visible Playwright Chrome window open and wait for the user to finish them; do not classify them as terminal failures unless the wait times out.

## Search Strategy

Prefer a logged-in persistent browser context. For search:

1. Prefer direct user search URLs: `https://www.douyin.com/search/<encoded-keyword>?type=user`, then `/jingxuan/search/<encoded-keyword>?type=user` as fallback.
2. If direct URLs show login or verification, keep the visible browser open and wait for manual completion, then retry the same direct URL.
3. Use header search only as fallback:
   - Try `locator('[data-e2e="searchbar-input"]')`.
   - Fall back to `input[placeholder*="搜索"]`, `input[type="search"]`, and `[role="searchbox"]`.
   - Use Enter and the visible search button as fallbacks.
4. For broad niches, use multi-keyword sequential search in one process, with keywords derived from the user's category, then merge/deduplicate by canonical profile URL.
5. Do not run parallel Playwright processes with the same persistent `--user-data-dir`; Chrome will reject the second owner or attach it to the existing browser outside Playwright control.

## Candidate Parsing Strategy

Douyin search result markup changes frequently. Use layered extraction:

- First try stable or semi-stable `data-e2e` values containing `user`, `card`, `search`.
- Then inspect visible anchors whose `href` contains `/user/`.
- Ignore `/user/self` navigation links.
- Extract profile URL from anchor `href`.
- Extract creator name from the first clean line before `关注` or `抖音号:`; avoid keeping the entire card text as the name.
- Extract fan count from nearby text using Chinese labels such as `粉丝`, `获赞`, and numeric units `万`, `w`, `亿`.

Do not rely on a single selector like `[data-e2e="user-card"]`.

## Send Strategy

Use profile-first sending:

1. Open the approved `profile_url`.
2. Confirm a visible identity signal matches the approved row.
3. Click a visible profile-level `私信` button if available.
4. Locate the active DM editor with `[contenteditable="true"]`, `[role="textbox"]`, or `textarea` inside the visible DM panel.
5. Clear the editor and insert the approved full message using keyboard-equivalent input.
6. Send only after user approval; optionally read back the editor for the first row or when the user requests safer mode.

Stop for CAPTCHA, slider verification, SMS/login verification, platform risk prompts, send limits, or unclear recipient/editor state.
