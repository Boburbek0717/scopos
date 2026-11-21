/**
 * Scopos overlay. Injected on demand by the service worker.
 *
 * SCOPOS_SCAN tags the page's visible interactive elements with
 * data-scopos-id and returns a description of each one. SCOPOS_START then
 * walks the user through the steps Claude returned: scroll to the target,
 * fly the blue cursor to it, ring it with a glowing box, and show the
 * instruction in a card beside it. Advancing is always the user's choice.
 */
(() => {
  if (window.__scoposLoaded) return;
  window.__scoposLoaded = true;

  const ATTR = 'data-scopos-id';
  const MAX_ELEMENTS = 400;
  const INTERACTIVE = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
    '[role="menuitemcheckbox"]', '[role="menuitemradio"]', '[role="option"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="combobox"]',
    '[role="treeitem"]', '[contenteditable="true"]', '[contenteditable=""]', '[onclick]',
  ].join(',');
  const AUTO_ACTIONS = new Set(['click', 'type', 'select']);
  const FLY_MS = 650;
  // After the last step's click, wait this long for a new page before looking at this one again.
  const RESCAN_DELAY_MS = 1500;
  const CURSOR_TIP = 2.5; // the triangle's tip sits 2.5px in from the cursor box's corner
  const EDGE = 12;
  const GAP = 14;

  const CURSOR_SVG = `
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <defs>
        <linearGradient id="scopos-cursor-gradient" x1="10%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#e0f2fe"/>
          <stop offset="50%" stop-color="#7dd3fc"/>
          <stop offset="100%" stop-color="#2563eb"/>
        </linearGradient>
      </defs>
      <polygon points="4,4 34,14 14,32" fill="url(#scopos-cursor-gradient)" stroke="url(#scopos-cursor-gradient)" stroke-width="3" stroke-linejoin="round"/>
      <polyline points="4,4 34,14" fill="none" stroke="rgba(255,255,255,0.65)" stroke-width="1.4" stroke-linecap="round"/>
      <polyline points="4,4 14,32" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="1" stroke-linecap="round"/>
    </svg>`;

  const state = {
    ui: null,
    steps: [],
    index: 0,
    target: null,
    phase: 'idle', // idle | thinking | error | scrolling | flying | holding | text
    token: 0,
    raf: 0,
    lastPoint: null,
    dismissed: false,
    leaving: false, // a new page is loading in this tab
  };

  // ── Scanning ──────────────────────────────────────────────────────────

  const clean = (value, max = 80) => (value || '').replace(/\s+/g, ' ').trim().slice(0, max);

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    if (!el.checkVisibility) return true;
    return el.checkVisibility({
      checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true,
    });
  }

  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  }

  function shortHref(raw) {
    if (!raw || /^\s*javascript:/i.test(raw)) return '';
    try {
      const url = new URL(raw, location.href);
      const path = url.origin === location.origin ? url.pathname + url.hash : url.host + url.pathname;
      return clean(path, 100);
    } catch {
      return '';
    }
  }

  function elementState(el) {
    const flags = [];
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') flags.push('disabled');
    if (el.getAttribute('aria-selected') === 'true') flags.push('selected');
    if (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') flags.push('current');
    if (el.checked || el.getAttribute('aria-checked') === 'true') flags.push('checked');
    if (el.getAttribute('aria-expanded') === 'true') flags.push('expanded');
    return flags.join(', ');
  }

  // Never reads field values: typed text (passwords included) stays on the page.
  function describe(el, id) {
    const tag = el.tagName.toLowerCase();
    const isField = tag === 'input' || tag === 'textarea' || el.isContentEditable
      || ['textbox', 'searchbox'].includes(el.getAttribute('role'));
    const label = el.getAttribute('aria-label')
      || el.labels?.[0]?.innerText
      || el.getAttribute('title')
      || el.getAttribute('alt')
      || el.querySelector('img[alt]')?.getAttribute('alt');
    return {
      id,
      tag,
      role: el.getAttribute('role') || '',
      type: tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '',
      text: isField ? '' : clean(el.innerText || el.textContent),
      label: clean(label),
      placeholder: clean(el.getAttribute('placeholder')),
      name: clean(el.getAttribute('name'), 40),
      href: tag === 'a' ? shortHref(el.getAttribute('href')) : '',
      state: elementState(el),
      inViewport: inViewport(el),
    };
  }

  function scan() {
    document.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR));

    const found = [];
    const seen = new Set();
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (el.closest('.scopos-root') || !isVisible(el)) continue;
      // A clickable span inside a button is the same control; keep the outer one.
      const parent = el.parentElement?.closest(INTERACTIVE);
      if (parent && seen.has(parent) && !el.matches('input, select, textarea')) continue;
      seen.add(el);
      found.push(el);
    }

    let chosen = found;
    if (found.length > MAX_ELEMENTS) {
      // Too many to send: everything on screen first, then the rest in page order.
      const keep = new Set(found.filter(inViewport).slice(0, MAX_ELEMENTS));
      for (const el of found) {
        if (keep.size >= MAX_ELEMENTS) break;
        keep.add(el);
      }
      chosen = found.filter((el) => keep.has(el));
    }

    const elements = chosen.map((el, i) => {
      const id = `s${i + 1}`;
      el.setAttribute(ATTR, id);
      return describe(el, id);
    });

    return {
      url: location.origin + location.pathname,
      title: clean(document.title, 120),
      elements,
      truncated: found.length > chosen.length,
    };
  }

  // ── Overlay UI ────────────────────────────────────────────────────────

  function ensureUI() {
    if (state.ui) return state.ui;

    const root = document.createElement('div');
    root.className = 'scopos-root';
    root.innerHTML = `
      <div class="scopos-box"></div>
      <div class="scopos-cursor">${CURSOR_SVG}</div>
      <div class="scopos-card" role="dialog" aria-label="Scopos guide">
        <div class="scopos-head">
          <span class="scopos-title">Scopos</span>
          <button type="button" class="scopos-btn scopos-btn-ghost" data-act="stop" title="Stop this walkthrough (Esc)">Stop</button>
        </div>
        <div class="scopos-body" aria-live="polite">
          <div class="scopos-thinking"><span class="scopos-spinner"></span><span>Looking at this page…</span></div>
          <p class="scopos-text"></p>
          <p class="scopos-note"></p>
        </div>
        <div class="scopos-foot">
          <div class="scopos-dots"></div>
          <button type="button" class="scopos-btn" data-act="auto">Auto-Click</button>
          <button type="button" class="scopos-btn scopos-btn-primary" data-act="next">Next Step</button>
        </div>
      </div>`;
    // Inside <body> so assistive tech sees the card; frameset pages have no body.
    (document.body || document.documentElement).appendChild(root);

    const q = (selector) => root.querySelector(selector);
    const ui = {
      root,
      box: q('.scopos-box'),
      cursor: q('.scopos-cursor'),
      card: q('.scopos-card'),
      title: q('.scopos-title'),
      thinking: q('.scopos-thinking'),
      text: q('.scopos-text'),
      note: q('.scopos-note'),
      foot: q('.scopos-foot'),
      dots: q('.scopos-dots'),
      stop: q('[data-act="stop"]'),
      auto: q('[data-act="auto"]'),
      next: q('[data-act="next"]'),
    };

    // Keep the page's "click outside" handlers from closing an open menu
    // when the user presses a button on the card.
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'keydown']) {
      ui.card.addEventListener(type, (event) => event.stopPropagation());
    }
    ui.stop.addEventListener('click', endGuide);
    ui.next.addEventListener('click', nextStep);
    ui.auto.addEventListener('click', autoClick);

    state.ui = ui;
    state.raf = requestAnimationFrame(frame);
    return ui;
  }

  function teardown() {
    cancelAnimationFrame(state.raf);
    state.ui?.root.remove();
    state.ui = null;
    state.steps = [];
    state.target = null;
    state.phase = 'idle';
    state.lastPoint = null;
    state.token++;
    document.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR));
  }

  // The service worker keeps the guide alive across page loads; tell it where we are.
  function notifyBackground(message) {
    chrome.runtime.sendMessage(message).catch(() => { /* extension reloaded; nothing to tell */ });
  }

  // The user is finished: close the overlay and stop following this tab.
  function endGuide() {
    state.dismissed = true;
    notifyBackground({ type: 'SCOPOS_END' });
    teardown();
  }

  function setCard({ title, text = '', note = '', thinking = false, footer = false, stopLabel = 'Stop' }) {
    const ui = ensureUI();
    ui.title.textContent = title;
    ui.thinking.hidden = !thinking;
    ui.text.textContent = text;
    ui.text.hidden = !text;
    ui.note.textContent = note;
    ui.note.hidden = !note;
    ui.foot.hidden = !footer;
    ui.stop.textContent = stopLabel;
    ui.card.classList.add('scopos-on');
  }

  function showThinking(goal) {
    state.dismissed = false;
    state.phase = 'thinking';
    state.target = null;
    setCard({ title: 'Scopos', thinking: true, note: goal ? `Goal: ${goal}` : '' });
  }

  function showError(message) {
    if (state.dismissed) return;
    state.phase = 'error';
    state.target = null;
    setCard({ title: 'Scopos', text: message, stopLabel: 'Close' });
  }

  // ── Walkthrough ───────────────────────────────────────────────────────

  function start(steps) {
    if (state.dismissed || !Array.isArray(steps) || !steps.length) return;
    state.steps = steps;
    goTo(0);
  }

  function findTarget(step) {
    if (!step.targetId) return null;
    return document.querySelector(`[${ATTR}="${CSS.escape(step.targetId)}"]`);
  }

  function goTo(index) {
    const ui = ensureUI();
    const step = state.steps[index];
    const total = state.steps.length;
    const token = ++state.token;
    state.index = index;
    state.target = findTarget(step);
    notifyBackground({ type: 'SCOPOS_PROGRESS', index });

    let note = '';
    if (state.target) {
      // The element's own name, read from the page, so the user can check
      // what Auto-Click will press before trusting Claude's wording.
      const d = describe(state.target, step.targetId);
      const name = d.text || d.label || d.placeholder || d.name;
      if (name) note = `Points at: “${clean(name, 60)}”`;
    } else if (step.actionType !== 'read') {
      note = step.targetId
        ? "Scopos can't see this element right now. Follow the text for this one."
        : 'Not on this page yet. Follow the text for this one.';
    }
    setCard({ title: `Step ${index + 1} of ${total}`, text: step.instruction, note, footer: true });

    ui.dots.replaceChildren(...state.steps.map((_, i) => {
      const dot = document.createElement('span');
      dot.className = `scopos-dot${i === index ? ' scopos-dot-on' : ''}`;
      return dot;
    }));
    ui.next.textContent = index === total - 1 ? 'Done' : 'Next Step';
    ui.auto.disabled = !state.target || !AUTO_ACTIONS.has(step.actionType);
    ui.box.classList.remove('scopos-on');

    if (!state.target) {
      state.phase = 'text';
      return;
    }

    state.phase = 'scrolling';
    state.target.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center', inline: 'nearest' });
    waitForStill(state.target, token, () => fly(token));
  }

  // Smooth scrolling has no reliable "done" event across nested scrollers,
  // so wait until the target stops moving (or give up after 1.2s).
  function waitForStill(el, token, done) {
    const started = performance.now();
    let last = '';
    let stillFrames = 0;
    const check = () => {
      if (token !== state.token) return;
      const r = el.getBoundingClientRect();
      const key = `${Math.round(r.left)},${Math.round(r.top)}`;
      stillFrames = key === last ? stillFrames + 1 : 0;
      last = key;
      if (stillFrames >= 5 || performance.now() - started > 1200) done();
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }

  function fly(token) {
    const ui = state.ui;
    const r = state.target?.getBoundingClientRect();
    if (!ui || !r) return;

    const to = aimPoint(r);
    const from = state.lastPoint || { x: innerWidth - 48, y: innerHeight - 48 };
    ui.cursor.classList.add('scopos-holding'); // no transition while placing the start point
    placeCursor(from);
    void ui.cursor.offsetWidth; // commit the start position before animating
    ui.cursor.classList.remove('scopos-holding');
    ui.cursor.classList.add('scopos-on');
    state.phase = 'flying';
    placeCursor(to);
    state.lastPoint = to;

    setTimeout(() => {
      if (token !== state.token || !state.ui) return;
      state.phase = 'holding';
      state.ui.cursor.classList.add('scopos-holding');
    }, reducedMotion() ? 0 : FLY_MS);
  }

  function nextStep() {
    if (state.index >= state.steps.length - 1) {
      endGuide();
      return;
    }
    goTo(state.index + 1);
  }

  // The highlighted element was clicked, by the user or by Auto-Click.
  function targetClicked() {
    // A click that can open a page (a link, a submit button, or the last step) approves
    // that page for the guide, in this tab or in a new tab it opens.
    const lastStep = state.index === state.steps.length - 1;
    if (lastStep || state.target?.closest('a[href], [type="submit"]')) notifyBackground({ type: 'SCOPOS_CLICKED' });
    if (state.index < state.steps.length - 1) {
      goTo(state.index + 1);
      return;
    }
    // Last step. Usually a new page loads and the service worker picks the guide
    // up there. Apps that redraw in place keep this page, so look at it again.
    teardown();
    const token = state.token;
    setTimeout(() => {
      if (!state.leaving && token === state.token) notifyBackground({ type: 'SCOPOS_RESCAN' });
    }, RESCAN_DELAY_MS);
  }

  function autoClick() {
    const step = state.steps[state.index];
    const el = state.target;
    if (!el?.isConnected || !AUTO_ACTIONS.has(step.actionType)) return;

    el.focus({ preventScroll: true });
    if (step.actionType === 'select' && typeof el.showPicker === 'function') {
      try { el.showPicker(); } catch { /* the field still has focus */ }
      return;
    }
    if (step.actionType === 'type') return; // the user types the text themselves
    el.click();
    targetClicked(); // el.click() is a synthetic event, which the click listener below ignores
  }

  // ── Layout loop ───────────────────────────────────────────────────────

  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

  function aimPoint(r) {
    return { x: r.left + Math.min(r.width / 2, 48), y: r.top + r.height / 2 };
  }

  function placeCursor(point) {
    state.ui.cursor.style.transform = `translate(${point.x - CURSOR_TIP}px, ${point.y - CURSOR_TIP}px)`;
  }

  function frame() {
    const ui = state.ui;
    if (!ui) return;
    state.raf = requestAnimationFrame(frame);

    const el = state.target;
    const r = el?.isConnected ? el.getBoundingClientRect() : null;
    const onScreen = Boolean(r && r.width > 0 && r.height > 0
      && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth);
    const pointing = onScreen && (state.phase === 'flying' || state.phase === 'holding');

    if (pointing) {
      const pad = 6;
      ui.box.style.transform = `translate(${r.left - pad}px, ${r.top - pad}px)`;
      ui.box.style.width = `${r.width + pad * 2}px`;
      ui.box.style.height = `${r.height + pad * 2}px`;
      ui.box.classList.add('scopos-on');
    } else {
      ui.box.classList.remove('scopos-on');
    }

    if (state.phase === 'holding' && pointing) {
      const point = aimPoint(r);
      placeCursor(point);
      state.lastPoint = point;
    }
    ui.cursor.classList.toggle('scopos-on', pointing);

    placeCard(ui.card, onScreen && state.phase !== 'scrolling' ? r : null);
  }

  function placeCard(card, r) {
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    let left;
    let top;

    if (!r) {
      left = innerWidth - w - 20;
      top = innerHeight - h - 20;
    } else if (r.bottom + GAP + h <= innerHeight - EDGE) {
      left = r.left;
      top = r.bottom + GAP;
    } else if (r.top - GAP - h >= EDGE) {
      left = r.left;
      top = r.top - GAP - h;
    } else {
      // No room above or below: sit beside the element.
      left = innerWidth - r.right >= w + GAP + EDGE ? r.right + GAP : r.left - GAP - w;
      top = r.top;
    }

    left = clamp(left, EDGE, Math.max(EDGE, innerWidth - w - EDGE));
    top = clamp(top, EDGE, Math.max(EDGE, innerHeight - h - EDGE));
    card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  // ── Wiring ────────────────────────────────────────────────────────────

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.ui) endGuide();
  }, true);

  // Clicking the highlighted element yourself counts as doing the step.
  // Only real clicks: a page script can't push the guide along with synthetic ones.
  document.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    const step = state.steps[state.index];
    if (!state.ui || !state.target || step?.actionType !== 'click') return;
    if (event.target instanceof Node && state.target.contains(event.target)) targetClicked();
  }, true);

  window.addEventListener('beforeunload', () => { state.leaving = true; });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case 'SCOPOS_SCAN':
        teardown(); // a new scan replaces any walkthrough already on the page
        sendResponse(scan());
        break;
      case 'SCOPOS_THINKING':
        showThinking(message.goal);
        sendResponse({ ok: true });
        break;
      case 'SCOPOS_START':
        start(message.steps);
        sendResponse({ ok: true });
        break;
      case 'SCOPOS_ERROR':
        showError(message.message);
        sendResponse({ ok: true });
        break;
      case 'SCOPOS_PING':
        // Lets the service worker tell a new page (no answer) from this one.
        sendResponse({ alive: true });
        break;
      case 'SCOPOS_STOP':
        teardown();
        sendResponse({ ok: true });
        break;
      default:
        return false;
    }
    return false;
  });
})();
