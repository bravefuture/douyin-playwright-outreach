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
const MANUAL_AUTH_RE = /登录后|扫码登录|密码登录|获取验证码|请输入手机号|请输入验证码|验证码中间页|安全验证|请完成.*验证|滑块|拼图|拖动.*滑块/;
const HARD_RISK_RE = /操作过于频繁|风险|账号异常|限制|私信功能暂不可用/;

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

  return page.evaluate(({ patternSource, watchInputsOnly }) => {
    const authRe = new RegExp(patternSource);
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const selectors = watchInputsOnly
      ? ["input", "textarea", "[contenteditable='true']", "[role='textbox']", "[role='dialog']", "[aria-modal='true']"]
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
      const text = (node.innerText || node.textContent || node.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim();
      if (!text || text === "登录" || text.length > 500) continue;
      const match = text.match(authRe);
      if (match) return match[0];
    }
    return "";
  }, { patternSource: MANUAL_AUTH_RE.source, watchInputsOnly: Boolean(options["auth-watch-inputs-only"]) }).catch(() => "");
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
  const pollMs = Number(options["manual-auth-poll-ms"] || 5000);
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
  await page.waitForTimeout(Number(options["post-auth-wait-ms"] || 1200));
  if (typeof retryFn === "function") {
    await retryFn();
  } else {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
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
    const nodes = Array.from(document.querySelectorAll("div,span,p,button,[role='button']"));
    const visible = nodes.map((node, index) => {
      const rect = node.getBoundingClientRect();
      const itemText = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
      const className = String(node.className || "");
      return {
        index,
        text: itemText.slice(0, 240),
        className: className.slice(0, 180),
        visible: rect.width > 0 && rect.height > 0,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      };
    }).filter((item) => item.visible);
    const expectedNodes = visible.filter((item) => item.text.includes(expected));
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

  await page.keyboard.press("Enter");
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
    if (String(result.status).startsWith("stopped")) break;
  }

  const out = { command: "send", input, results };
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await context.close();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!["probe", "search", "send"].includes(command)) {
    console.error("Usage: douyin_playwright_outreach.js <probe|search|send> [--keyword ...]");
    process.exit(2);
  }
  if (command === "probe") await probe(args);
  if (command === "search") await search(args);
  if (command === "send") await send(args);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
