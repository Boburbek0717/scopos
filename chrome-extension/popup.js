const $ = (id) => document.getElementById(id);

const goalInput = $('goal');
const guideBtn = $('guideBtn');
const statusLine = $('status');
const modelSelect = $('model');
const keyInput = $('apiKey');
const keyChip = $('keyChip');
const removeKeyBtn = $('removeKey');

let hasKey = false;
const demoAvailable = Boolean(self.SCOPOS_CONFIG?.demoProxyUrl);

function setStatus(text, isError = false) {
  statusLine.textContent = text;
  statusLine.classList.toggle('error', isError);
}

function renderKeyState(saved) {
  hasKey = saved;
  keyChip.textContent = saved ? 'Connected' : demoAvailable ? 'Optional' : 'Needed';
  keyChip.className = `chip ${saved || demoAvailable ? 'ok' : 'needed'}`;
  keyInput.placeholder = saved ? '•••••••• saved. Paste a new key to replace it.' : 'sk-ant-…';
  removeKeyBtn.hidden = !saved;
  $('demoNote').hidden = saved || !demoAvailable;
}

async function init() {
  const stored = await chrome.storage.local.get(['scoposApiKey', 'scoposModel', 'scoposGoal']);
  renderKeyState(Boolean(stored.scoposApiKey));
  if (stored.scoposModel && modelSelect.querySelector(`option[value="${CSS.escape(stored.scoposModel)}"]`)) {
    modelSelect.value = stored.scoposModel;
  }
  if (stored.scoposGoal) goalInput.value = stored.scoposGoal;
  (hasKey || demoAvailable ? goalInput : keyInput).focus();

  // A guide that reached a page Scopos couldn't open: clicking the icon granted
  // access to this page, so carry on without asking for the goal again.
  const tab = await activeTab();
  const status = tab?.id ? await chrome.runtime.sendMessage({ type: 'SCOPOS_STATUS', tabId: tab.id }) : null;
  if (status?.waiting) {
    goalInput.value = status.goal;
    await runGuide({ type: 'SCOPOS_CONTINUE', tabId: tab.id }, 'Continuing your guide on this page…');
  }
}

$('keyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = keyInput.value.trim();
  if (!key) {
    setStatus('Paste your Anthropic API key first.', true);
    return;
  }
  if (!key.startsWith('sk-ant-')) {
    setStatus("That doesn't look like an Anthropic key. They start with sk-ant-.", true);
    return;
  }
  await chrome.storage.local.set({ scoposApiKey: key });
  keyInput.value = '';
  renderKeyState(true);
  setStatus('Key saved.');
  goalInput.focus();
});

removeKeyBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove('scoposApiKey');
  renderKeyState(false);
  setStatus('Key removed.');
  keyInput.focus();
});

modelSelect.addEventListener('change', () => {
  chrome.storage.local.set({ scoposModel: modelSelect.value });
});

// Enter sends, Shift+Enter adds a new line.
goalInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('guideForm').requestSubmit();
  }
});

$('guideForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const goal = goalInput.value.trim();
  if (!hasKey && !demoAvailable) {
    setStatus('Add your Anthropic API key below first.', true);
    keyInput.focus();
    return;
  }
  if (!goal) {
    setStatus('Type where you want to go.', true);
    return;
  }

  await chrome.storage.local.set({ scoposGoal: goal });
  const tab = await activeTab();
  if (!tab?.id) {
    setStatus('No active tab found.', true);
    return;
  }
  await runGuide({ type: 'SCOPOS_GUIDE', tabId: tab.id, goal }, 'Looking at the page…');
});

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function runGuide(message, waitingText) {
  guideBtn.disabled = true;
  setStatus(waitingText);
  try {
    const result = await chrome.runtime.sendMessage(message);
    if (result?.ok) {
      setStatus(`${result.stepCount} step${result.stepCount === 1 ? '' : 's'} ready. Follow the card on the page.`);
      setTimeout(() => window.close(), 700);
    } else {
      setStatus(result?.error || 'Something went wrong. Try again.', true);
    }
  } catch {
    setStatus('Scopos stopped responding. Try again.', true);
  } finally {
    guideBtn.disabled = false;
  }
}

init();
