/**
 * Scopos service worker.
 *
 * The popup asks for a walkthrough (SCOPOS_GUIDE). This worker injects the
 * content script into the tab, collects the page's interactive elements,
 * asks Claude for ordered steps, and hands those steps to the overlay.
 * It runs the whole flow itself so it still finishes if the popup closes.
 */

importScripts('config.js', 'prompt.js');

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEMO_PROXY_URL = self.SCOPOS_CONFIG?.demoProxyUrl || '';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-opus-5-5';
const MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
// Haiku has no server-side refusal fallback; on the others a decline is re-run on a fallback model.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);
const { system: SYSTEM_PROMPT, schema: STEPS_SCHEMA, actionTypes: ACTION_TYPES } = self.SCOPOS_PROMPT;
const MAX_GOAL_LENGTH = 500;
const MAX_TOKENS = 16000;
const REQUEST_TIMEOUT_MS = 180000;
// A walkthrough follows the tab across page loads, up to this many pages.
const MAX_PAGES = 10;
// Earlier pages Claude is told about when it plans the next one.
const HISTORY_PAGES = 3;
// A guide with no activity for this long doesn't wake up on the next page load.
const SESSION_TTL_MS = 10 * 60 * 1000;
// Give script-rendered pages a moment to draw their buttons before scanning.
const SETTLE_MS = 600;

class NoAccessError extends Error {}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const fromPopup = !sender.tab; // the popup is an extension page; content scripts have a tab

  switch (message?.type) {
    case 'SCOPOS_GUIDE':
      if (!fromPopup) return false;
      reply(startGuide(message.tabId, message.goal), sendResponse);
      return true; // keep the channel open for the async response
    case 'SCOPOS_CONTINUE':
      if (!fromPopup) return false;
      reply(continueGuide(message.tabId), sendResponse);
      return true;
    case 'SCOPOS_STATUS':
      if (!fromPopup) return false;
      getSession(message.tabId).then((s) => sendResponse({ waiting: Boolean(s?.waiting), goal: s?.goal ?? '' }));
      return true;
    case 'SCOPOS_PROGRESS':
      if (!fromPopup) recordProgress(sender.tab.id, message.index);
      return false;
    case 'SCOPOS_END':
      if (!fromPopup) endSession(sender.tab.id);
      return false;
    case 'SCOPOS_RESCAN':
      if (!fromPopup) rescanPage(sender.tab.id);
      return false;
    default:
      return false;
  }
});

// A page load in a tab with a guide running: pick the guide up on the new page.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') resumeAfterNavigation(tabId);
});

// Tabs with a plan being made right now, so overlapping events plan only once.
const busyTabs = new Set();

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(sessionKey(tabId));
});

function reply(promise, sendResponse) {
  promise.then(
    (stepCount) => sendResponse({ ok: true, stepCount }),
    (err) => sendResponse({ ok: false, error: err.message }),
  );
}

// ── Sessions (chrome.storage.session survives the service worker sleeping) ──

const sessionKey = (tabId) => `guide:${tabId}`;

async function getSession(tabId) {
  if (!Number.isInteger(tabId)) return null;
  const key = sessionKey(tabId);
  return (await chrome.storage.session.get(key))[key] ?? null;
}

async function saveSession(tabId, session) {
  await chrome.storage.session.set({ [sessionKey(tabId)]: session });
}

async function endSession(tabId) {
  await chrome.storage.session.remove(sessionKey(tabId));
  await showWaitingBadge(tabId, false);
}

async function recordProgress(tabId, index) {
  const session = await getSession(tabId);
  const page = session?.pages.at(-1);
  if (!page || !Number.isInteger(index)) return;
  page.index = Math.max(0, Math.min(index, page.steps.length - 1));
  session.lastActivityAt = Date.now();
  await saveSession(tabId, session);
}

/**
 * Run `work` unless the tab already has a plan in progress. The tab is marked
 * busy before the first await, so two events arriving together can't both start.
 */
async function exclusive(tabId, work) {
  if (busyTabs.has(tabId)) return null;
  busyTabs.add(tabId);
  try {
    return await work();
  } finally {
    busyTabs.delete(tabId);
  }
}

function resumeAfterNavigation(tabId) {
  return exclusive(tabId, async () => {
    const session = await getSession(tabId);
    if (!session) return;
    // Measured from the last step shown or advanced, never from page-load bookkeeping.
    if (Date.now() - session.lastActivityAt > SESSION_TTL_MS) {
      await endSession(tabId);
      return;
    }
    // The overlay answers only on the page it was injected into: no answer means a new page.
    if (await overlayAlive(tabId)) return;

    try {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      await runPage(tabId, session);
    } catch (err) {
      if (err instanceof NoAccessError) {
        // A page Scopos may not enter (chrome://, the Web Store): one click on the icon continues.
        session.waiting = true;
        await saveSession(tabId, session);
        await showWaitingBadge(tabId, true);
      }
      // Other errors are already shown on the page's card.
    }
  });
}

// The last step was clicked but the page stayed (apps that redraw in place): look again.
function rescanPage(tabId) {
  return exclusive(tabId, async () => {
    const session = await getSession(tabId);
    if (!session) return;
    session.lastActivityAt = Date.now();
    await runPage(tabId, session).catch(() => { /* already shown on the page's card */ });
  });
}

async function overlayAlive(tabId) {
  try {
    const answer = await chrome.tabs.sendMessage(tabId, { type: 'SCOPOS_PING' });
    return answer?.alive === true;
  } catch {
    return false;
  }
}

async function showWaitingBadge(tabId, on) {
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? '→' : '' });
    if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });
    await chrome.action.setTitle({ tabId, title: on ? 'Click to continue your Scopos guide' : 'Scopos' });
  } catch {
    // The tab is gone; nothing to show.
  }
}

// ── Guiding ─────────────────────────────────────────────────────────────

async function startGuide(tabId, rawGoal) {
  if (!Number.isInteger(tabId)) throw new Error('No active tab found. Click on the page and try again.');
  const goal = typeof rawGoal === 'string' ? rawGoal.trim().slice(0, MAX_GOAL_LENGTH) : '';
  if (!goal) throw new Error('Type where you want to go first.');

  const result = await exclusive(tabId, async () => {
    const session = { goal, pages: [], waiting: false, lastActivityAt: Date.now() };
    await saveSession(tabId, session);
    return runPage(tabId, session);
  });
  return result ?? busyError();
}

async function continueGuide(tabId) {
  const result = await exclusive(tabId, async () => {
    const session = await getSession(tabId);
    if (!session) throw new Error('There is no guide to continue. Type a goal and click Guide Me.');
    session.lastActivityAt = Date.now();
    return runPage(tabId, session);
  });
  return result ?? busyError();
}

function busyError() {
  throw new Error('Scopos is already working on this page. Give it a few seconds.');
}

/** Scan the tab's current page, plan the next steps, and show them. */
async function runPage(tabId, session) {
  const settings = await loadSettings();

  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch {
    throw new NoAccessError(
      "Scopos can't run on this page. Browser pages like chrome:// and the Chrome Web Store are off limits. Open a regular website and try again.",
    );
  }

  session.waiting = false;
  await saveSession(tabId, session);
  await showWaitingBadge(tabId, false);

  if (session.pages.length >= MAX_PAGES) {
    await endSession(tabId);
    return showErrorAndThrow(tabId, `Scopos stopped after ${MAX_PAGES} pages. Click Guide Me to start again.`);
  }

  const page = await sendToTab(tabId, { type: 'SCOPOS_SCAN' });
  await sendToTab(tabId, { type: 'SCOPOS_THINKING', goal: session.goal });

  let steps;
  try {
    steps = await requestSteps({ ...settings, page, goal: session.goal, history: session.pages.slice(-HISTORY_PAGES) });
  } catch (err) {
    return showErrorAndThrow(tabId, err.message);
  }

  session.pages.push({ title: page.title, url: page.url, steps: steps.map((s) => s.instruction), index: 0 });
  await saveSession(tabId, session);
  await sendToTab(tabId, { type: 'SCOPOS_START', steps });
  return steps.length;
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(['scoposApiKey', 'scoposModel']);
  const apiKey = stored.scoposApiKey;
  if (!apiKey && !DEMO_PROXY_URL) throw new Error('Add your Anthropic API key in the Scopos popup first.');
  return { apiKey, model: MODELS.has(stored.scoposModel) ? stored.scoposModel : DEFAULT_MODEL };
}

// Show the failure on the page too: the popup may already be closed.
async function showErrorAndThrow(tabId, message) {
  await chrome.tabs.sendMessage(tabId, { type: 'SCOPOS_ERROR', message }).catch(() => {});
  throw new Error(message);
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    throw new Error('The page changed while Scopos was working. Try again.');
  }
}

async function requestSteps({ apiKey, model, page, goal, history = [] }) {
  // Your own key goes straight to Anthropic; without one, the demo server adds its key.
  const url = apiKey ? API_URL : DEMO_PROXY_URL;
  const headers = { 'content-type': 'application/json', 'anthropic-version': API_VERSION };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
    // Extension pages send an Origin header; the API rejects it without this opt-in.
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: describePage(page, goal, history) }],
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: STEPS_SCHEMA },
    },
  };
  if (FALLBACK_MODELS.has(model)) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('Claude took too long to answer. Try again.');
    throw new Error(apiKey
      ? 'Could not reach the Anthropic API. Check your internet connection.'
      : 'Could not reach the Scopos demo server. Check your internet connection, or add your own API key.');
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(apiErrorMessage(response.status, data, !apiKey));
  if (data?.stop_reason === 'refusal') throw new Error('Claude declined to help with this request.');
  if (data?.stop_reason === 'max_tokens') {
    throw new Error('The answer was too long to finish. Try a narrower goal.');
  }

  const ids = new Set((page?.elements ?? []).map((e) => e.id));
  const steps = parseSteps(data, ids);
  if (!steps.length) throw new Error('Claude returned no steps. Try saying your goal another way.');
  return steps;
}

function describePage(page, goal, history = []) {
  const elements = page?.elements ?? [];
  const lines = elements.length ? elements.map(elementLine) : ['(no interactive elements found)'];
  const note = page?.truncated ? '\n(the page has more elements than listed; the visible ones come first)' : '';
  const earlier = history.length
    ? `\n\nearlier pages in this walkthrough:\n${history.map(historyLine).join('\n')}\nthe user has now landed on the page above.`
    : '';
  return `page title: ${page?.title || '(untitled)'}
url: ${page?.url || '(unknown)'}

interactive elements:
${lines.join('\n')}${note}${earlier}

goal: ${goal}`;
}

function historyLine(p) {
  const steps = p.steps.map((s, i) => `${i + 1}. ${s}`).join(' ');
  return `- ${JSON.stringify(p.title || '(untitled)')} (${p.url}): planned ${steps} (the user was on step ${p.index + 1})`;
}

function elementLine(e) {
  const kind = e.role || (e.tag === 'a' ? 'link' : e.tag === 'input' ? `${e.type || 'text'} input` : e.tag);
  const parts = [`[${e.id}] ${kind}`];
  if (e.text) parts.push(JSON.stringify(e.text));
  if (e.label && e.label !== e.text) parts.push(`label=${JSON.stringify(e.label)}`);
  if (e.placeholder) parts.push(`placeholder=${JSON.stringify(e.placeholder)}`);
  if (e.name) parts.push(`name=${JSON.stringify(e.name)}`);
  if (e.href) parts.push(`-> ${e.href}`);
  if (e.state) parts.push(`(${e.state})`);
  if (!e.inViewport) parts.push('(offscreen)');
  return parts.join(' ');
}

/**
 * The schema fixes the shape, but the model's ids are still checked against
 * the scan: an unknown id becomes null so the overlay never points at nothing.
 */
function parseSteps(data, ids) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks.filter((b) => b.type === 'text').pop()?.text;
  if (!text) return [];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Claude's answer couldn't be read. Try again.");
  }

  return (Array.isArray(parsed?.steps) ? parsed.steps : [])
    .filter((s) => typeof s?.instruction === 'string' && s.instruction.trim())
    .map((s, i) => {
      const targetId = typeof s.targetId === 'string' && ids.has(s.targetId) ? s.targetId : null;
      const actionType = ACTION_TYPES.includes(s.actionType) ? s.actionType : targetId ? 'click' : 'read';
      return { step: i + 1, targetId, instruction: s.instruction.trim(), actionType };
    });
}

function apiErrorMessage(status, data, usingDemo) {
  const detail = data?.error?.message;
  if (status === 401) return 'Anthropic rejected the API key. Paste it again in the Scopos popup.';
  if (usingDemo && status === 400 && /credit|spend|limit/i.test(detail ?? '')) {
    return 'The free demo budget is used up. Add your own Anthropic API key in the Scopos popup.';
  }
  if (status === 403) return `This API key isn't allowed to use that model. ${detail ?? ''}`.trim();
  if (status === 429) return 'Too many requests right now. Wait a moment and try again.';
  if (status >= 500) return "Anthropic's API is busy or down. Try again in a minute.";
  return `Anthropic API error ${status}: ${detail ?? 'unknown error'}`;
}
