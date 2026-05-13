#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const SKILL_ROOT = path.resolve(__dirname, "..");
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (error) {
  for (const candidate of [
    path.join(SKILL_ROOT, "node_modules", "playwright"),
    path.join(process.cwd(), "node_modules", "playwright"),
    "/tmp/node_modules/playwright",
  ]) {
    try {
      ({ chromium } = require(candidate));
      break;
    } catch (_) {
      // Keep trying known install locations.
    }
  }
  if (!chromium) {
    console.error("Playwright is not installed. Run: npm install playwright");
    process.exit(2);
  }
}

const DEFAULT_PROFILE = path.join(process.env.HOME || "/tmp", ".douyin-playwright-profile");
const MANUAL_AUTH_RE = /登录后|扫码登录|密码登录|获取验证码|请输入手机号|请输入验证码|验证码中间页|验证码|图形码|图形验证|安全验证|请完成.*验证|滑块|拼图|拖动.*滑块|点选|依次点击|captcha|verify|secsdk/i;
const STRONG_MANUAL_AUTH_RE = /登录后|扫码登录|密码登录|获取验证码|请输入手机号|请输入验证码|验证码中间页|图形码|图形验证|安全验证|请完成.{0,20}验证|拖动.{0,20}滑块|依次点击|captcha|verify|secsdk/i;
const WEAK_MANUAL_AUTH_RE = /验证码|滑块|拼图|点选/i;
const AUTH_CONTAINER_RE = /captcha|verify|secsdk|captcha_verify|captcha-container|security|login|验证码|验证|安全/i;
const HARD_RISK_RE = /操作过于频繁|账号异常|账号存在异常|账号被封禁|账号受限|功能受限|私信功能暂不可用|发送过于频繁|今日发送次数已达上限|请稍后再试|平台限制发送|存在安全风险|安全风险提示|违反社区规范|系统检测到异常/;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function parseFans(text) {
  if (!text) return null;
  const compact = String(text).replace(/,/g, "").replace(/\s+/g, "");
  const match = compact.match(/(\d+(?:\.\d+)?)(亿|万|w|W)?/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2];
  if (unit === "亿") return Math.round(value * 100000000);
  if (unit === "万" || unit === "w" || unit === "W") return Math.round(value * 10000);
  return Math.round(value);
}

function uniqBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function splitKeywords(args) {
  const raw = args.keywords || args.keyword || "";
  return String(raw)
    .split(/[,，|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function shouldStopSending(status) {
  return [
    "stopped_manual_auth_timeout",
    "stopped_risk",
    "stopped_after_send_check",
  ].includes(status);
}

function isFalseOption(value) {
  return value === false || /^(0|false|off|no)$/i.test(String(value || ""));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sendDelayMs(options = {}) {
  if (options["no-send-delay"] || isFalseOption(options["send-delay"])) return 0;
  const min = Number(options["send-delay-min-ms"] || 3000);
  const max = Number(options["send-delay-max-ms"] || 10000);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= 0) return 0;
  return randomInt(Math.max(0, Math.min(min, max)), Math.max(min, max));
}

function monitorIntervalMs(options = {}) {
  if (options["interval-ms"]) {
    const fixed = Number(options["interval-ms"]);
    return Number.isFinite(fixed) && fixed > 0 ? fixed : 30000;
  }
  const min = Number(options["interval-min-ms"] || 30000);
  const max = Number(options["interval-max-ms"] || 60000);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= 0) return 30000;
  return randomInt(Math.max(0, Math.min(min, max)), Math.max(min, max));
}

function inboxSignature(snapshot) {
  if (!snapshot) return "";
  const names = (snapshot.conversations || [])
    .slice(0, 8)
    .map((item) => `${item.name}:${item.preview}:${item.time}:${item.unread ? 1 : 0}`)
    .join("|");
  return `${snapshot.unread_count_estimate}:${snapshot.has_unread ? 1 : 0}:${names}`;
}

async function openContext(options) {
  const userDataDir = options["user-data-dir"] || DEFAULT_PROFILE;
  const headless = Boolean(options.headless);
  return chromium.launchPersistentContext(userDataDir, {
    channel: options.channel || "chrome",
    headless,
    viewport: { width: Number(options.width || 1365), height: Number(options.height || 900) },
    slowMo: Number(options["slow-mo"] || 0),
  });
}

async function visibleBodyText(page) {
  return page.locator("body").innerText({ timeout: 8000 }).catch(() => "");
}

async function manualAuthReason(page, options = {}) {
  const title = await page.title().catch(() => "");
  const url = page.url();
  const titleMatch = title.match(MANUAL_AUTH_RE);
  if (titleMatch) return titleMatch[0];
  if (/captcha|verify|login/i.test(url)) return "verification_url";

  return page.evaluate(({ patternSource, strongPatternSource, weakPatternSource, containerPatternSource, watchInputsOnly }) => {
    const authRe = new RegExp(patternSource);
    const strongAuthRe = new RegExp(strongPatternSource);
    const weakAuthRe = new RegExp(weakPatternSource);
    const containerRe = new RegExp(containerPatternSource);
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const selectors = watchInputsOnly
      ? [
        "input",
        "textarea",
        "[contenteditable='true']",
        "[role='textbox']",
        "[role='dialog']",
        "[aria-modal='true']",
        "[class*='captcha']",
        "[class*='verify']",
        "[id*='captcha']",
        "[id*='verify']",
        "canvas",
        "img",
        "button",
      ]
      : [
        "[role='dialog']",
        "[aria-modal='true']",
        "[class*='login']",
        "[class*='captcha']",
        "[class*='verify']",
        "input",
        "button",
        "div",
        "span",
        "p",
      ];
    const nodes = Array.from(document.querySelectorAll(selectors.join(",")));
    for (const node of nodes) {
      if (!isVisible(node)) continue;
      const nodeMeta = [
        node.getAttribute("class") || "",
        node.getAttribute("id") || "",
        node.getAttribute("role") || "",
      ].join(" ");
      const text = [
        node.innerText || node.textContent || "",
        node.getAttribute("placeholder") || "",
        node.getAttribute("aria-label") || "",
        node.getAttribute("alt") || "",
        node.getAttribute("title") || "",
        nodeMeta,
      ].join(" ").replace(/\s+/g, " ").trim();
      if (!text || text === "登录" || text.length > 1000) continue;
      const strongMatch = text.match(strongAuthRe);
      if (strongMatch) return strongMatch[0];
      const weakMatch = text.match(weakAuthRe);
      if (!weakMatch) continue;
      const container = node.closest("[role='dialog'],[aria-modal='true'],[class*='captcha'],[class*='verify'],[id*='captcha'],[id*='verify'],[class*='login'],[id*='login']");
      const containerText = container
        ? [
          container.innerText || container.textContent || "",
          container.getAttribute("class") || "",
          container.getAttribute("id") || "",
          container.getAttribute("role") || "",
        ].join(" ").replace(/\s+/g, " ").trim()
        : "";
      const inAuthContainer = container && containerRe.test(containerText);
      const match = inAuthContainer ? text.match(authRe) : null;
      if (match) return match[0];
    }
    return "";
  }, {
    patternSource: MANUAL_AUTH_RE.source,
    strongPatternSource: STRONG_MANUAL_AUTH_RE.source,
    weakPatternSource: WEAK_MANUAL_AUTH_RE.source,
    containerPatternSource: AUTH_CONTAINER_RE.source,
    watchInputsOnly: Boolean(options["auth-watch-inputs-only"]),
  }).catch(() => "");
}

async function riskState(page, options = {}) {
  const text = await visibleBodyText(page);
  const title = await page.title().catch(() => "");
  const combined = `${title}\n${text}`;
  const hardMatch = combined.match(HARD_RISK_RE);
  const authReason = await manualAuthReason(page, options);
  return {
    risk: Boolean(hardMatch || authReason),
    type: hardMatch ? "hard_risk" : authReason ? "manual_auth" : "",
    reason: hardMatch ? hardMatch[0] : authReason || "",
    url: page.url(),
  };
}

async function waitForManualAuth(page, options, label) {
  if (options["no-wait-login"]) return false;
  const timeoutMs = Number(options["login-timeout-ms"] || 300000);
  const pollMs = Number(options["manual-auth-poll-ms"] || 2000);
  const stableChecksRequired = Number(options["manual-auth-stable-checks"] || 3);
  const deadline = Date.now() + timeoutMs;
  let lastReason = "";
  let stableClearChecks = 0;
  while (Date.now() < deadline) {
    const state = await riskState(page, { ...options, "auth-watch-inputs-only": true });
    if (state.type !== "manual_auth") {
      stableClearChecks += 1;
      if (stableClearChecks >= stableChecksRequired) return true;
      await page.waitForTimeout(pollMs);
      continue;
    }
    stableClearChecks = 0;
    if (state.reason !== lastReason) {
      console.error(`[douyin] Paused for manual login/verification in Chrome (${label}): ${state.reason}. Finish it in the visible Chrome window. Automation will not click, type, scroll, or reload until the verification state is gone for ${stableChecksRequired} checks.`);
      lastReason = state.reason;
    }
    await page.waitForTimeout(pollMs);
  }
  return false;
}

async function waitForManualAuthAndRetry(page, options, label, retryFn) {
  const ok = await waitForManualAuth(page, options, label);
  if (!ok) return { ok: false, state: { ...(await riskState(page)), timeout: true } };
  await page.waitForTimeout(Number(options["post-auth-wait-ms"] || 1500));
  if (typeof retryFn === "function") {
    await retryFn();
  }
  await page.waitForTimeout(Number(options["post-auth-retry-wait-ms"] || 1800));
  return { ok: true, state: await riskState(page) };
}

async function findSearchInput(page) {
  const selectors = [
    '[data-e2e="searchbar-input"]',
    'input[placeholder*="搜索"]',
    'input[type="search"]',
    '[role="searchbox"]',
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) return locator;
  }
  return null;
}

async function waitForSearchInput(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const locator = await findSearchInput(page);
    if (locator) return locator;
    await page.waitForTimeout(1000);
  }
  return null;
}

async function goToUserSearch(page, keyword) {
  const encoded = encodeURIComponent(keyword);
  const urls = [
    `https://www.douyin.com/search/${encoded}?type=user`,
    `https://www.douyin.com/jingxuan/search/${encoded}?type=user`,
  ];
  for (const url of urls) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const state = await riskState(page);
    if (state.type === "hard_risk") return state;
    if (!state.risk && page.url().includes("type=user")) return state;
    if (state.type === "manual_auth") return state;
  }
  return riskState(page);
}

async function searchViaHeader(page, keyword, options = {}) {
  let search = await waitForSearchInput(page, 10000);
  if (!search) {
    await page.goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);
    search = await waitForSearchInput(page, 8000);
  }
  if (!search) {
    await page.goto("https://www.douyin.com/aisearch", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);
    search = await waitForSearchInput(page, 10000);
  }
  if (!search) throw new Error("Could not find Douyin search input");

  await search.click();
  await search.fill(keyword);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);

  const afterEnter = await riskState(page);
  if (afterEnter.type === "manual_auth") {
    const retry = await waitForManualAuthAndRetry(page, options, "after search", () => goToUserSearch(page, keyword));
    if (!retry.ok) return retry.state;
    if (!retry.state.risk && page.url().includes("type=user")) return retry.state;
    return performSearch(page, keyword, options);
  }
  if (afterEnter.risk) return afterEnter;

  const userTab = page.getByText(/^用户$/).first();
  if (await userTab.count().catch(() => 0)) {
    await userTab.click().catch(() => {});
    await page.waitForTimeout(1500);
  }
  if (!page.url().includes("type=user")) {
    return goToUserSearch(page, keyword);
  }
  return riskState(page);
}

async function performSearch(page, keyword, options = {}) {
  let initialState = await goToUserSearch(page, keyword);
  if (initialState.type === "manual_auth") {
    const retry = await waitForManualAuthAndRetry(page, options, "user search", () => goToUserSearch(page, keyword));
    if (!retry.ok) return retry.state;
    initialState = retry.state;
  }
  if (initialState.type === "hard_risk") return initialState;
  if (!initialState.risk && page.url().includes("type=user")) return initialState;
  if (options["direct-only"]) return initialState;
  return searchViaHeader(page, keyword, options);
}

async function scrollAndCollect(page, minFans, maxResults, options = {}) {
  const maxScrolls = Number(options.scrolls || 10);
  const stableLimit = Number(options["stable-scrolls"] || 3);
  let best = [];
  let stable = 0;
  for (let i = 0; i <= maxScrolls; i += 1) {
    const state = await riskState(page, options);
    if (state.type === "manual_auth") {
      const retry = await waitForManualAuthAndRetry(page, options, "during result scrolling");
      if (!retry.ok || retry.state.risk) return best;
    }
    if (state.type === "hard_risk") return best;
    const current = await extractCandidates(page, minFans, maxResults);
    if (current.length > best.length) {
      best = current;
      stable = 0;
      if (best.length >= maxResults) break;
    } else {
      stable += 1;
      if (stable >= stableLimit && best.length > 0) break;
    }
    await page.mouse.wheel(0, 1000);
    await page.waitForTimeout(900);
  }
  return best;
}

async function extractProbe(page) {
  return {
    url: page.url(),
    title: await page.title().catch(() => ""),
    inputs: await page.locator("input, textarea, [contenteditable=true], [role=textbox]").evaluateAll((els) =>
      els.slice(0, 30).map((el, index) => {
        const rect = el.getBoundingClientRect();
        return {
          index,
          tag: el.tagName,
          type: el.getAttribute("type"),
          placeholder: el.getAttribute("placeholder"),
          role: el.getAttribute("role"),
          dataE2E: el.getAttribute("data-e2e"),
          text: (el.innerText || el.value || "").slice(0, 120),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        };
      })
    ).catch(() => []),
    dataE2E: await page.locator("[data-e2e]").evaluateAll((els) =>
      Array.from(new Set(els.slice(0, 300).map((el) => el.getAttribute("data-e2e")).filter(Boolean))).slice(0, 100)
    ).catch(() => []),
    bodyText: (await visibleBodyText(page)).slice(0, 3000),
  };
}

async function extractCandidates(page, minFans, maxResults) {
  const candidates = await page.evaluate(() => {
    const rows = [];
    const cleanName = (anchor, text) => {
      const lines = `${anchor.innerText || ""}\n${text || ""}`
        .split(/\n|关注|抖音号:/)
        .map((item) => item.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      return lines.find((line) =>
        !/认证徽章|发过相关视频|粉丝|获赞|^抖音号|商务|合作|教程|简介/.test(line)
      ) || "";
    };
    const anchors = Array.from(document.querySelectorAll('a[href*="/user/"]'));
    for (const anchor of anchors) {
      const card = anchor.closest('[data-e2e*="user"], [class*="user"], [class*="card"], li, div') || anchor;
      const text = (card.innerText || anchor.innerText || "").replace(/\s+/g, " ").trim();
      const href = anchor.href;
      if (href.includes("/user/self")) continue;
      const name = cleanName(anchor, card.innerText || anchor.innerText || "").replace(/^@/, "").trim();
      if (!href || !name) continue;
      rows.push({ creator_name: name, profile_url: href, raw_text: text.slice(0, 500) });
    }
    return rows;
  });

  const normalized = candidates.map((row) => {
    const fanMatch = row.raw_text.match(/粉丝[^\d]*(\d+(?:\.\d+)?\s*(?:万|w|W|亿)?|\d[\d,]*)|(\d+(?:\.\d+)?\s*(?:万|w|W|亿)?)\s*粉丝/);
    const rawFans = fanMatch ? (fanMatch[1] || fanMatch[2]) : "";
    const fans = parseFans(rawFans);
    return {
      ...row,
      raw_fans: rawFans,
      fans,
      status: fans == null ? "needs_review_no_fan_count" : fans >= minFans ? "candidate" : "below_min_fans",
    };
  });

  return uniqBy(normalized, (row) => row.profile_url)
    .filter((row) => row.status === "candidate" || row.status === "needs_review_no_fan_count")
    .slice(0, maxResults);
}

async function probe(args) {
  const context = await openContext(args);
  const page = context.pages()[0] || await context.newPage();
  const keyword = args.keyword || "美食博主";
  await page.goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  const home = await extractProbe(page);
  let search = null;
  if (keyword) {
    try {
      const state = await performSearch(page, keyword, args);
      search = { state, probe: await extractProbe(page) };
    } catch (error) {
      search = { error: error.message, probe: await extractProbe(page) };
    }
  }
  console.log(JSON.stringify({ command: "probe", keyword, home, search }, null, 2));
  await context.close();
}

async function search(args) {
  const keywords = splitKeywords(args);
  if (!keywords.length) throw new Error("--keyword or --keywords is required");
  const minFans = Number(args["min-fans"] || 0);
  const maxResults = Number(args["max-results"] || 30);
  const targetCount = Number(args["target-count"] || maxResults);
  const context = await openContext(args);
  const page = context.pages()[0] || await context.newPage();
  const merged = [];
  const seen = new Set();
  const searches = [];

  for (const keyword of keywords) {
    const state = await performSearch(page, keyword, args);
    if (state.risk) {
      const payload = { command: "search", stopped: true, keyword, state, candidates: merged };
      console.log(JSON.stringify(payload, null, 2));
      await context.close();
      return;
    }
    const candidates = await scrollAndCollect(page, minFans, Math.max(maxResults, targetCount), args);
    searches.push({ keyword, url: page.url(), count: candidates.length });
    for (const row of candidates) {
      const key = row.profile_url.split("?")[0];
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
      if (merged.length >= targetCount) break;
    }
    if (merged.length >= targetCount) break;
  }

  const payload = {
    command: "search",
    keywords,
    min_fans: minFans,
    target_count: targetCount,
    searches,
    count: merged.slice(0, targetCount).length,
    candidates: merged.slice(0, targetCount),
  };
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
  await context.close();
}

async function findDmEditor(page, timeoutMs = 10000) {
  const selectors = ['textarea', '[contenteditable="true"]', '[role="textbox"]'];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locators = await page.locator(selector).all();
      for (const locator of locators) {
        if (await locator.isVisible().catch(() => false)) {
          const placeholder = await locator.getAttribute("placeholder").catch(() => "");
          const box = await locator.boundingBox().catch(() => null);
          if (placeholder && /搜索/.test(placeholder)) continue;
          if (box && box.y < 80) continue;
          return locator;
        }
      }
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function waitForManualDmOpen(page, row, options) {
  if (options["no-wait-manual-dm"]) return null;
  const timeoutMs = Number(options["manual-dm-timeout-ms"] || 180000);
  console.error(`[douyin] Please manually click the profile-level 私信 button for ${row.creator_name || row.profile_url}. Waiting for the chat editor...`);
  return findDmEditor(page, timeoutMs);
}

async function openDmEditor(page, row, options = {}) {
  const attempts = Number(options["dm-click-attempts"] || 4);
  for (let i = 0; i < attempts; i += 1) {
    const editorBefore = await findDmEditor(page, 800);
    if (editorBefore) return { editor: editorBefore, opened: true };

    const opened = await clickPrivateMessage(page);
    let state = await riskState(page);
    if (state.type === "manual_auth") {
      const retry = await waitForManualAuthAndRetry(page, options, `after DM click for ${row.creator_name || row.profile_url}`, () =>
        page.goto(row.profile_url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {})
      );
      if (!retry.ok) return { state: retry.state, opened };
      state = retry.state;
      if (state.risk) return { state, opened };
      continue;
    }
    if (state.risk) return { state, opened };

    const editor = await findDmEditor(page, 5000);
    if (editor) return { editor, opened };
    await page.waitForTimeout(800);
  }

  return { editor: await waitForManualDmOpen(page, row, options), opened: false };
}

async function clickPrivateMessage(page) {
  const buttons = [
    page.locator('[data-e2e="user-detail"] button:has-text("私信")').first(),
    page.locator('[data-e2e="user-info"] button:has-text("私信")').first(),
    page.locator('button:has-text("私信")').first(),
  ];
  for (const button of buttons) {
    if (await button.count().catch(() => 0)) {
      if (await button.isVisible().catch(() => false)) {
        await button.click({ force: true });
        await page.waitForTimeout(2000);
        return true;
      }
    }
  }
  return false;
}

async function hoverInboxPanel(page) {
  const panelPoint = await page.evaluate(() => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const panels = Array.from(document.querySelectorAll("div"))
      .filter(isVisible)
      .map((el) => ({ text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(), rect: el.getBoundingClientRect() }))
      .filter((item) => /私信（?\d*）?/.test(item.text) && item.rect.x > window.innerWidth * 0.55 && item.rect.y >= 45 && item.rect.width > 0)
      .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0];
    if (!panels) return null;
    return {
      x: Math.round(panels.rect.x + Math.min(40, panels.rect.width / 2)),
      y: Math.round(panels.rect.y + Math.min(40, panels.rect.height / 2)),
    };
  }).catch(() => null);
  if (!panelPoint) return false;
  await page.mouse.move(panelPoint.x, panelPoint.y).catch(() => {});
  return true;
}

async function openImEntry(page) {
  const entries = [
    page.locator('[data-e2e="im-entry"]').first(),
    page.locator('a:has-text("私信")').first(),
    page.locator('button:has-text("私信")').first(),
    page.locator('[role="button"]:has-text("私信")').first(),
    page.getByText(/私信/).first(),
  ];
  for (const entry of entries) {
    if (await entry.count().catch(() => 0)) {
      if (await entry.isVisible().catch(() => false)) {
        await entry.hover({ force: true }).catch(() => {});
        await page.waitForTimeout(800);
        let snapshot = await extractUnreadInbox(page).catch(() => null);
        if (snapshot?.has_inbox_panel) {
          await hoverInboxPanel(page);
          return true;
        }
        await entry.click({ force: true }).catch(() => {});
        return true;
      }
    }
  }

  const point = await page.evaluate(() => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const candidates = Array.from(document.querySelectorAll("a,button,div,span,[role='button']"))
      .filter(isVisible)
      .map((el) => ({ el, text: (el.innerText || el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim(), rect: el.getBoundingClientRect() }))
      .filter((item) => /私信/.test(item.text) && item.rect.x > window.innerWidth * 0.55 && item.rect.y < 140)
      .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));
    const target = candidates[0];
    if (!target) return null;
    return {
      x: Math.round(target.rect.x + target.rect.width / 2),
      y: Math.round(target.rect.y + target.rect.height / 2),
    };
  }).catch(() => false);
  if (!point) return false;
  await page.mouse.move(point.x, point.y).catch(() => {});
  await page.waitForTimeout(800);
  let snapshot = await extractUnreadInbox(page).catch(() => null);
  if (snapshot?.has_inbox_panel) {
    await hoverInboxPanel(page);
    return true;
  }
  await page.mouse.click(point.x, point.y).catch(() => {});
  return true;
}

async function openImInbox(page, options = {}) {
  await page.goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(Number(options["im-entry-initial-wait-ms"] || 3000));

  let state = await riskState(page);
  if (state.type === "manual_auth") {
    const retry = await waitForManualAuthAndRetry(page, options, "before inbox monitor", () =>
      page.goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {})
    );
    if (!retry.ok) return { ok: false, state: { ...retry.state, timeout: true } };
    state = retry.state;
  }
  if (state.risk) return { ok: false, state };

  const timeoutMs = Number(options["im-entry-timeout-ms"] || 60000);
  const pollMs = Number(options["im-entry-poll-ms"] || 2000);
  const deadline = Date.now() + timeoutMs;
  let lastState = state;
  while (Date.now() < deadline) {
    const opened = await openImEntry(page);
    if (opened) {
      await page.waitForTimeout(2500);
      const snapshot = await extractUnreadInbox(page);
      if (snapshot.has_inbox_panel) {
        await hoverInboxPanel(page);
        return { ok: true, state: await riskState(page) };
      }
    }
    lastState = await riskState(page, { ...options, "auth-watch-inputs-only": true });
    if (lastState.type === "manual_auth") {
      const retry = await waitForManualAuthAndRetry(page, options, "waiting for inbox entry");
      if (!retry.ok) return { ok: false, state: { ...retry.state, timeout: true } };
    } else if (lastState.type === "hard_risk") {
      return { ok: false, state: lastState };
    }
    await page.waitForTimeout(pollMs);
  }
  return { ok: false, state: { type: "not_found", reason: "im_entry_not_found", url: page.url(), last_state: lastState } };
}

async function extractUnreadInbox(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();
    const redLike = (el) => {
      const style = window.getComputedStyle(el);
      const bg = style.backgroundColor || "";
      const color = style.color || "";
      return /rgb\((2[0-5]\d|1[5-9]\d),\s*([0-9]\d?|1[0-4]\d),\s*([0-9]\d?|1[0-4]\d)\)/.test(bg) ||
        /rgb\((2[0-5]\d|1[5-9]\d),\s*([0-9]\d?|1[0-4]\d),\s*([0-9]\d?|1[0-4]\d)\)/.test(color);
      };
    const nodes = Array.from(document.querySelectorAll("div,span,p,a,button,[role='button']"))
      .filter(isVisible)
      .map((node, index) => {
        const rect = node.getBoundingClientRect();
        return {
          index,
          text: clean(node.innerText || node.textContent).slice(0, 220),
          className: String(node.className || "").slice(0, 180),
          ariaLabel: clean(node.getAttribute("aria-label")),
          title: clean(node.getAttribute("title")),
          red: redLike(node),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        };
      });

    const allText = clean(document.body.innerText || "");
    const titleMatch = allText.match(/私信（(\d+)）|私信\((\d+)\)/);
    const headerUnread = titleMatch ? Number(titleMatch[1] || titleMatch[2] || 0) : 0;
    const panelCandidates = nodes.filter((item) => {
      if (item.x < window.innerWidth * 0.58) return false;
      if (item.y < 45 || item.y > 130) return false;
      if (item.w < 180 || item.h < 35) return false;
      return /私信/.test(item.text);
    });
    const hasInboxPanel = panelCandidates.length > 0;

    const unreadBadges = nodes.filter((item) => {
      const label = `${item.text} ${item.ariaLabel} ${item.title} ${item.className}`;
      const badgeSized = item.w > 0 && item.w <= 80 && item.h > 0 && item.h <= 80;
      const nearInboxPanel = item.x > window.innerWidth * 0.55 || /badge|count|red|unread/i.test(label);
      return /未读|新消息|条新消息|unread/i.test(label) ||
        (nearInboxPanel && item.red && badgeSized && (/^\d{1,3}$/.test(item.text) || item.text === "" || item.w <= 16 || item.h <= 16));
    });

    const conversationHints = nodes.filter((item) => {
      const label = `${item.text} ${item.ariaLabel} ${item.title}`;
      if (!label || label.length < 2) return false;
      return /未读|新消息|刚刚|分钟前|小时前|昨天|星期|回复|收到|私信/.test(label);
    }).slice(0, 30);

    const conversations = nodes.filter((item) => {
      if (!hasInboxPanel) return false;
      if (item.x < window.innerWidth * 0.55) return false;
      if (item.y < 95) return false;
      if (item.w < 180 || item.w > 360 || item.h < 36 || item.h > 130) return false;
      const text = item.text;
      if (!text || text.length < 4 || text.length > 180) return false;
      if (/^私信（?\d*）?$|搜索|充钻石|客户端|壁纸|通知|投稿/.test(text)) return false;
      if (/^\d{1,2}:\d{2}\s+\d+/.test(text)) return false;
      if (/@.+·\s*(刚刚|\d+\s*分钟前|\d+\s*小时前|昨天|星期|周)/.test(text) && /#/.test(text)) return false;
      return /刚刚|分钟前|小时前|昨天|星期|周|回复|您好|消息|撤回|粉丝群|合作|私信/.test(text);
    }).slice(0, 20).map((item) => {
      const parts = item.text.split(/\s+/).filter(Boolean);
      const timeMatch = item.text.match(/刚刚|\d+\s*分钟前|\d+\s*小时前|昨天|星期[一二三四五六日天]|周[一二三四五六日天]/);
      const unread = /未读|新消息/.test(item.text) || unreadBadges.some((badge) => Math.abs(badge.y - item.y) < 40);
      return {
        name: parts[0] || item.text.slice(0, 20),
        preview: item.text.slice(0, 120),
        time: timeMatch ? timeMatch[0] : "",
        unread,
        x: item.x,
        y: item.y,
      };
    });

    const unreadCount = unreadBadges.reduce((sum, item) => {
      const match = item.text.match(/^\d{1,3}$/);
      return sum + (match ? Number(match[0]) : 1);
    }, 0);
    const estimatedUnread = Math.max(headerUnread, unreadCount);

    return {
      url: location.href,
      title: document.title,
      inbox_loaded: Boolean(hasInboxPanel && (titleMatch || conversations.length > 0)),
      has_inbox_panel: hasInboxPanel,
      inbox_title_unread: headerUnread,
      unread_count_estimate: estimatedUnread,
      has_unread: estimatedUnread > 0 || unreadBadges.length > 0,
      unread_badges: unreadBadges.slice(0, 20),
      conversations,
      conversation_hints: conversationHints,
      checked_at: new Date().toISOString(),
    };
  });
}

async function waitForInboxLoaded(page, options = {}) {
  const timeoutMs = Number(options["inbox-load-timeout-ms"] || 20000);
  const pollMs = Number(options["inbox-load-poll-ms"] || 1000);
  const stableChecksRequired = Number(options["inbox-stable-checks"] || 2);
  const deadline = Date.now() + timeoutMs;
  let lastSignature = "";
  let stableChecks = 0;
  let lastSnapshot = null;

  while (Date.now() < deadline) {
    const state = await riskState(page, options);
    if (state.type === "manual_auth") {
      const retry = await waitForManualAuthAndRetry(page, options, "before inbox list load");
      if (!retry.ok || retry.state.risk) return { ok: false, state: retry.state, snapshot: lastSnapshot };
    } else if (state.type === "hard_risk") {
      return { ok: false, state, snapshot: lastSnapshot };
    }

    const snapshot = await extractUnreadInbox(page);
    lastSnapshot = snapshot;
    const signature = inboxSignature(snapshot);
    if (snapshot.inbox_loaded && signature && signature === lastSignature) {
      stableChecks += 1;
      if (stableChecks >= stableChecksRequired) return { ok: true, snapshot };
    } else {
      stableChecks = 0;
      lastSignature = signature;
    }
    await page.waitForTimeout(pollMs);
  }

  return {
    ok: false,
    state: { type: "timeout", reason: "inbox_load_timeout", url: page.url() },
    snapshot: lastSnapshot,
  };
}

async function verifySendResult(page, message, options = {}) {
  const waitMs = Number(options["send-check-wait-ms"] || 3000);
  await page.waitForTimeout(waitMs);
  const state = await riskState(page);
  if (state.risk) {
    return { ok: false, status: "stopped_after_send_check", reason: state.reason };
  }

  const snapshot = await page.evaluate((expected) => {
    const failureRe = /发送失败|重新发送|重试|未送达|消息发送失败|网络异常|无法发送|对方暂不接收|隐私设置/;
    const text = document.body.innerText || "";
    const nodes = Array.from(document.querySelectorAll("div,span,p,button,[role='button'],textarea,[contenteditable='true'],[role='textbox']"));
    const visible = nodes.map((node, index) => {
      const rect = node.getBoundingClientRect();
      const itemText = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
      const className = String(node.className || "");
      const isEditor = node.matches("textarea,[contenteditable='true'],[role='textbox']") ||
        Boolean(node.closest("textarea,[contenteditable='true'],[role='textbox']"));
      return {
        index,
        text: itemText.slice(0, 240),
        className: className.slice(0, 180),
        isEditor,
        visible: rect.width > 0 && rect.height > 0,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      };
    }).filter((item) => item.visible);
    const expectedNodes = visible.filter((item) => !item.isEditor && item.text.includes(expected));
    const failureNodes = visible.filter((item) =>
      failureRe.test(item.text) ||
      /fail|error|warn|danger|retry|resend/i.test(item.className) ||
      /^[!！]$/.test(item.text)
    );
    const latestExpected = expectedNodes[expectedNodes.length - 1] || null;
    const nearbyFailures = latestExpected
      ? failureNodes.filter((item) => Math.abs(item.y - latestExpected.y) < 120 || item.y >= latestExpected.y - 40)
      : failureNodes;
    return {
      bodyHasExpected: text.includes(expected),
      failureText: (text.match(failureRe) || [])[0] || "",
      latestExpected,
      nearbyFailures: nearbyFailures.slice(-8),
      failureNodes: failureNodes.slice(-8),
    };
  }, message);

  if (snapshot.failureText || snapshot.nearbyFailures.length > 0) {
    return { ok: false, status: "failed_web_send", verification: snapshot };
  }
  if (snapshot.latestExpected || snapshot.bodyHasExpected) {
    return { ok: true, status: "sent", verification: snapshot };
  }
  return { ok: false, status: "send_unconfirmed", verification: snapshot };
}

async function clickSendMessage(page, editor, options = {}) {
  const clicked = await page.evaluate((editorEl) => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const editorRect = editorEl.getBoundingClientRect();
    const candidates = Array.from(document.querySelectorAll("button,[role='button'],div,span"))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const text = (node.innerText || node.textContent || node.getAttribute("aria-label") || node.getAttribute("title") || "")
          .replace(/\s+/g, " ")
          .trim();
        return { node, rect, text };
      })
      .filter((item) => {
        if (!isVisible(item.node)) return false;
        if (!/^发送$/.test(item.text)) return false;
        if (item.rect.width < 20 || item.rect.height < 20) return false;
        return item.rect.top >= editorRect.top - 80 && item.rect.left >= editorRect.left - 40;
      })
      .sort((a, b) => {
        const aDistance = Math.abs(a.rect.top - editorRect.top) + Math.abs(a.rect.left - editorRect.right);
        const bDistance = Math.abs(b.rect.top - editorRect.top) + Math.abs(b.rect.left - editorRect.right);
        return aDistance - bDistance;
      });
    const target = candidates[0];
    if (!target) return false;
    target.node.click();
    return true;
  }, await editor.elementHandle());

  if (clicked) return true;
  if (options["no-enter-send-fallback"]) return false;
  await page.keyboard.press("Enter");
  return false;
}

async function sendOne(page, row, message, verifyDraft, options = {}) {
  await page.goto(row.profile_url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1800);

  let state = await riskState(page);
  if (state.type === "manual_auth") {
    const retry = await waitForManualAuthAndRetry(page, options, `before DM for ${row.creator_name || row.profile_url}`, () =>
      page.goto(row.profile_url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {})
    );
    if (!retry.ok) return { ...row, status: "stopped_manual_auth_timeout", reason: retry.state.reason };
    state = retry.state;
  }
  if (state.risk) return { ...row, status: "stopped_risk", reason: state.reason };

  const dm = await openDmEditor(page, row, options);
  if (dm.state?.type === "manual_auth" && dm.state.timeout) {
    return { ...row, status: "stopped_manual_auth_timeout", reason: dm.state.reason };
  }
  if (dm.state?.risk) return { ...row, status: "stopped_risk", reason: dm.state.reason };

  const editor = dm.editor;
  if (!editor) return { ...row, status: dm.opened ? "failed_editor_unavailable" : "failed_dm_button_unavailable" };

  await editor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(message);

  if (verifyDraft) {
    const draft = await editor.evaluate((el) => (el.value || el.innerText || el.textContent || "").trim()).catch(() => "");
    if (draft !== message.trim()) {
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.press("Backspace");
      return { ...row, status: "failed_draft_mismatch", draft };
    }
  }

  await clickSendMessage(page, editor, options);
  const verified = await verifySendResult(page, message, options);
  if (verified.status === "stopped_after_send_check") {
    return { ...row, status: verified.status, reason: verified.reason };
  }
  return { ...row, status: verified.status, verification: verified.verification };
}

async function send(args) {
  const input = args.input;
  if (!input) throw new Error("--input is required");
  const payload = JSON.parse(fs.readFileSync(input, "utf8"));
  const rows = Array.isArray(payload) ? payload : payload.rows || payload.candidates || [];
  const maxSend = Number(args["max-send"] || 10);
  const context = await openContext(args);
  const page = context.pages()[0] || await context.newPage();
  const results = [];

  for (const row of rows.slice(0, maxSend)) {
    const message = row.approved_message || payload.approved_message || args.message;
    if (!row.profile_url || !message) {
      results.push({ ...row, status: "skipped_missing_profile_url_or_message" });
      continue;
    }
    const result = await sendOne(page, row, message, results.length === 0 || Boolean(args["verify-draft"]), args);
    results.push(result);
    if (shouldStopSending(result.status)) break;
    if (results.length < Math.min(rows.length, maxSend)) {
      const delayMs = sendDelayMs(args);
      if (delayMs > 0) {
        console.error(`[douyin] Waiting ${delayMs}ms before the next approved creator.`);
        await page.waitForTimeout(delayMs);
      }
    }
  }

  const out = { command: "send", input, results };
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await context.close();
}

async function monitor(args) {
  if (isFalseOption(args.enabled)) {
    const out = { command: "monitor", enabled: false, status: "disabled" };
    if (args.out) fs.writeFileSync(args.out, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const context = await openContext(args);
  const page = context.pages()[0] || await context.newPage();
  const open = await openImInbox(page, args);
  if (!open.ok || open.state?.risk) {
    const out = {
      command: "monitor",
      enabled: true,
      status: open.state?.timeout ? "stopped_manual_auth_timeout" : "failed_open_inbox",
      reason: open.state?.reason || "",
      state: open.state,
    };
    if (args.out) fs.writeFileSync(args.out, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
    await context.close();
    return;
  }

  const loaded = await waitForInboxLoaded(page, args);
  if (!loaded.ok) {
    const out = {
      command: "monitor",
      enabled: true,
      status: "failed_inbox_load",
      reason: loaded.state?.reason || "",
      state: loaded.state,
      last_snapshot: loaded.snapshot || null,
    };
    if (args.out) fs.writeFileSync(args.out, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
    await context.close();
    return;
  }

  const watch = Boolean(args.watch || args.realtime);
  const durationMs = Number(args["duration-ms"] || 0);
  const emitAll = Boolean(args["emit-all"]);
  const startedAt = Date.now();
  const checks = [];
  let lastSignature = "";
  let iteration = 0;

  while (true) {
    const state = await riskState(page, args);
    if (state.type === "manual_auth") {
      const retry = await waitForManualAuthAndRetry(page, args, "during inbox monitor", () => openImInbox(page, args));
      if (!retry.ok || retry.state.risk) {
        checks.push({ status: "stopped_manual_auth_timeout", reason: retry.state.reason, state: retry.state });
        break;
      }
    } else if (state.type === "hard_risk") {
      checks.push({ status: "stopped_risk", reason: state.reason, state });
      break;
    }

    const loadedCheck = iteration === 0 ? loaded : await waitForInboxLoaded(page, args);
    if (!loadedCheck.ok) {
      const item = {
        status: "failed_inbox_load",
        reason: loadedCheck.state?.reason || "",
        state: loadedCheck.state,
        last_snapshot: loadedCheck.snapshot || null,
        checked_at: new Date().toISOString(),
      };
      checks.push(item);
      console.error(`[douyin] Inbox load failed during realtime monitor (${item.reason || "unknown"}). Will reopen inbox and continue.`);
      if (!watch) break;
      await openImInbox(page, args).catch(() => null);
      iteration += 1;
      if (durationMs > 0 && Date.now() - startedAt >= durationMs) break;
      const waitMs = monitorIntervalMs(args);
      if (emitAll) console.error(`[douyin] Waiting ${waitMs}ms before retrying inbox check.`);
      await page.waitForTimeout(waitMs);
      continue;
    }
    await hoverInboxPanel(page);
    const snapshot = loadedCheck.snapshot || await extractUnreadInbox(page);
    const signature = inboxSignature(snapshot);
    const changed = signature !== lastSignature;
    const eventStatus = snapshot.has_unread ? "unread_detected" : "checked";
    const item = { status: eventStatus, changed, ...snapshot };
    checks.push(item);
    if (emitAll || iteration === 0 || changed || snapshot.has_unread) {
      console.log(JSON.stringify({ command: "monitor", enabled: true, watch, ...item }, null, 2));
    }
    lastSignature = signature;
    iteration += 1;

    if (!watch) break;
    if (durationMs > 0 && Date.now() - startedAt >= durationMs) break;
    const waitMs = monitorIntervalMs(args);
    if (emitAll) console.error(`[douyin] Waiting ${waitMs}ms before the next inbox check.`);
    await page.waitForTimeout(waitMs);
  }

  const out = { command: "monitor", enabled: true, watch, checks };
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(out, null, 2));
  await context.close();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!["probe", "search", "send", "monitor"].includes(command)) {
    console.error("Usage: douyin_playwright_outreach.js <probe|search|send|monitor> [--keyword ...]");
    process.exit(2);
  }
  if (command === "probe") await probe(args);
  if (command === "search") await search(args);
  if (command === "send") await send(args);
  if (command === "monitor") await monitor(args);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
