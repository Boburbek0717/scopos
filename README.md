# Scopos

**A Chrome extension that walks you through any website, one step at a time.**

### ▶ [Open the demo portal](https://scopos-demo-portal.boburbek.workers.dev) · [Download the extension (ZIP)](https://github.com/Boburbek0717/scopos/archive/refs/heads/main.zip)

Install the extension ([2-minute steps below](#try-it-in-2-minutes)), open the demo portal, and ask Scopos: *"Register me for the Calculus I written exam"*.

Type what you want to do, like *"Guide me to the exam registration page"*, and a blue cursor flies across the page to show you where to click. Scopos highlights the right button, explains the step in plain words, and follows you from page to page until you get there.

It's made for the moments when you know what you want but not where the button is: a university portal, a CRM, a ticket tracker, an admin panel, a government form.

---

## Try it in 2 minutes

No API key needed. The extension uses a hosted demo key.

1. Go to **https://github.com/Boburbek0717/scopos**, click **Code → Download ZIP**, and extract it.
2. Open `chrome://extensions` in Chrome and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the **`chrome-extension`** folder inside the extracted folder.
4. Click the puzzle-piece icon next to the address bar and **pin** Scopos.
5. Open any website, click the blue Scopos triangle, type your goal, and click **Guide Me**.

Goals to try:

| Site | Goal |
|---|---|
| [Demo University portal](https://scopos-demo-portal.boburbek.workers.dev) | Register me for the Calculus I written exam |
| python.org | Guide me to the page where I can download Python for Windows |
| wikipedia.org | Take me to a random article |
| github.com | How do I sign up? |

Scopos uses **Claude Haiku 5.5** by default, which answers in a few seconds. Sonnet 5.5 and Opus 5.5 are in the popup's model list if you want more careful answers.

### Demo portal

**https://scopos-demo-portal.boburbek.workers.dev**

[`demo-portal/`](demo-portal) is **Demo University**, a fictional student portal (plain HTML, no real data) built for this demo: busy menus, deadlines, quick links, and a full exam-registration flow. Open it, then ask Scopos:

> Register me for the Calculus I written exam

Scopos goes Home → Exams → Exam registration → the right row → tick the box → Confirm. To run it locally: `python -m http.server 8798 --directory demo-portal/public`, then open http://localhost:8798.

## What you'll see

1. The page scrolls to the element you need.
2. A glowing blue box rings it, and the Scopos cursor flies over and points at it.
3. A card beside it shows **Step 1 of N**, the instruction, and the element's real name on the page.
4. When a step opens a new page, Scopos looks at the new page and carries on from there.

| Control | What it does |
|---|---|
| **Next Step** | Go to the next instruction (clicking the highlighted element yourself does the same) |
| **Auto-Click** | Press the highlighted element for you (only when you press it) |
| **Stop** or `Esc` | End the guide |

## How it works

```
 popup ──goal──▶ service worker ──scan──▶ page (content script)
                     │                         │
                     │◀── buttons, links, ─────┘
                     │    tabs and field labels
                     ▼
           Claude (Messages API, structured output)
                     │
                     ▼ steps: { step, targetId, instruction, actionType }
             page overlay: scroll → highlight → cursor → step card
```

- **Scan.** The content script finds the visible interactive elements (buttons, links, inputs, tabs, menu items) and tags each one with a temporary `data-scopos-id`.
- **Plan.** The service worker sends that list and your goal to Claude. The answer must match a JSON schema, so every step names its target by id, and ids that weren't on the page are dropped.
- **Guide.** The overlay scrolls to each target, flies the cursor to it, and shows the step. Advancing is always your choice.
- **Follow.** The guide is remembered per tab. When the tab loads a new page, Scopos scans it and asks Claude for the next steps, telling it what happened on earlier pages. In apps that redraw without loading a new page, clicking the last step's element makes Scopos look at the page again. If the step's link opens a new tab, the guide moves to that tab. Clicking a link Scopos points at also lets it follow you onto the site that link goes to, once (a separate login or student-system address, for example). Otherwise it stays within the sites you started on: if you go somewhere else yourself, or to a page Chrome keeps extensions out of (like `chrome://`), the icon shows a **→** and nothing is read until you click it.

## Privacy and safety

- Scopos sends Claude the page title, its address (without the query string), and the **names and labels** of buttons, links and fields. **What you type into fields is never read or sent**, including rich-text editors.
- Page text is treated as data, not instructions: the prompt tells Claude to ignore anything on the page that tries to give it orders.
- The step card shows the element's own name from the page, so you can check what **Auto-Click** will press before pressing it.
- Nothing runs until you click **Guide Me**. A guide follows you within the sites you started on, and onto another site only when you click a link it points at, and only to the site that link goes to. Anywhere else it waits for a click on the icon. It stops after 10 pages, or after 10 minutes with no activity.
- Only real clicks move a guide forward, so a page's own scripts can't push it along or trigger extra requests.

## Project layout

```
chrome-extension/   the extension (Manifest V3, plain HTML/CSS/JS, no build step)
  manifest.json     permissions: activeTab, scripting, storage, plus site access so a guide can follow you to the next page
  popup.html/.js    goal, model and optional API key
  background.js     service worker: scanning, Claude requests, multi-page guides
  content.js/.css   page scan and the overlay (highlight, cursor, step card)
  prompt.js         the system prompt and step schema, shared with the demo server
  config.js         address of the demo server
proxy/              the demo server (Cloudflare Worker)
demo-portal/        Demo University, a fictional student portal to try Scopos on (static site)
scripts/
  test-extension.mjs  tests for the service worker and the demo server
  e2e-chrome.mjs      end-to-end test in real Chrome
```

## Demo server

[`proxy/worker.js`](proxy/worker.js) is a Cloudflare Worker that holds one Anthropic API key, so anyone can try Scopos without their own. It doesn't forward what the browser sends: it builds every request itself from the Scopos prompt and step schema, and takes only the model and the page description from the client. It allows 60 requests a minute per network (a shared event Wi-Fi can look like one network), and the key sits in an Anthropic workspace with a hard spend limit.

To run your own:

1. In the [Anthropic Console](https://console.anthropic.com), create a workspace with a spend limit and an API key inside it.
2. Deploy and add the key (you type the key into the prompt; it is never stored in the repo):
   ```bash
   cd proxy
   npx wrangler login
   npx wrangler deploy
   npx wrangler secret put ANTHROPIC_API_KEY
   ```
3. Put the address `wrangler deploy` printed, plus `/v1/messages`, into `demoProxyUrl` in [`chrome-extension/config.js`](chrome-extension/config.js), and add its origin to `host_permissions` in `chrome-extension/manifest.json`.

**Using your own key instead:** paste an Anthropic key into the popup. Requests then go straight to Anthropic and skip the demo server. The key is stored in Chrome's local extension storage.

## Tests

No dependencies and no build step:

```bash
node scripts/test-extension.mjs
```

It runs the service worker with a fake Chrome API and fake Claude replies (request shape, step clean-up, errors, multi-page guides, new tabs, the badge fallback, the page limit and the timeout), and checks that the demo server rejects anything that isn't a Scopos request.

**End to end in real Chrome:** loads the extension into a throwaway Chrome profile, serves a small three-page portal on localhost, and checks that a real guide (through the demo server) follows Home → Apply → Exam registration on its own:

```bash
npm install --no-save puppeteer-core@24.15.0
node scripts/e2e-chrome.mjs
```

Set `CHROME_PATH` if Chrome isn't in the default Windows location. One run uses about a cent of API credit.

## Built with

| Tool | Used for |
|---|---|
| Chrome Extensions, Manifest V3 | The extension: plain HTML, CSS and JavaScript, no build step |
| Claude API (Claude Haiku 5.5 by default; Sonnet 5.5 and Opus 5.5 optional) | Planning the steps, with structured output |
| Cloudflare Workers and Wrangler | The demo server that holds the API key |
| Claude Code (Anthropic's AI coding assistant) | Helped write the code, tests and documentation |
| Puppeteer | The end-to-end test in real Chrome |
| Node.js | Running the tests |

## Known limits

- Elements inside iframes and inside web components' shadow DOM aren't seen.
- Menu items that only appear after a click can't be highlighted; those steps show as text.
- Chrome's own pages (`chrome://`, the Web Store) can't be guided.

## Credits

The pointing-cursor idea comes from [Clicky](https://github.com/farzaa/clicky) by [Farza](https://github.com/farzaa). No Clicky code is included.

## License

MIT. See [LICENSE](LICENSE).
