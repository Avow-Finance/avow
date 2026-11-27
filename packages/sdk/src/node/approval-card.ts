/**
 * The card a client that renders MCP Apps shows when the model calls `connect` or
 * `request_change`. For a connection it shows the agent's name, its pairing code and a button
 * that opens the approval link. For a change it shows each value as it stands now beside the
 * value asked for, and a button that opens the request's signing page. Only the administrator's
 * passkey approves either, on Avow's page. While a request is open the card asks `status` or
 * `request_status` every few seconds and changes on its own. The card signs nothing and holds no
 * key, and a client that renders no card still gets the same text and link.
 */

/** The address the `connect` tool names for its card. */
export const APPROVAL_CARD_URI = 'ui://avow-sandbox/approval'

/** The type an MCP Apps client expects of a card. */
export const APPROVAL_CARD_MIME = 'text/html;profile=mcp-app'

/** How often the card asks where the request stands while it waits, in milliseconds. */
const REFRESH_MS = 4000

const STYLE = `
:root {
  --bg: var(--color-background-primary, #ffffff);
  --fg: var(--color-text-primary, #16151a);
  --muted: var(--color-text-secondary, #67646f);
  --accent: #7856f0;
  --accent-fg: #ffffff;
  --done: var(--color-text-success, #1a7f4b);
  --danger: var(--color-text-danger, #b42318);
  color-scheme: light;
}
:root[data-theme="dark"] {
  --bg: var(--color-background-primary, #17161b);
  --fg: var(--color-text-primary, #f2f1f5);
  --muted: var(--color-text-secondary, #a19eaa);
  --accent: #9a80f5;
  --accent-fg: #ffffff;
  --done: var(--color-text-success, #4cc38a);
  --danger: var(--color-text-danger, #f97066);
  color-scheme: dark;
}
* { box-sizing: border-box; margin: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.45 var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
  padding: 18px 20px;
}
.title { font-size: 15px; font-weight: 600; }
.text { color: var(--muted); margin-top: 4px; }
.code {
  font: 600 28px/1.1 var(--font-mono, ui-monospace, Menlo, monospace);
  letter-spacing: 0.06em;
  margin-top: 14px;
}
.actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 16px; }
button {
  font: inherit; font-weight: 600; border: 0; cursor: pointer;
  background: var(--accent); color: var(--accent-fg);
  padding: 9px 16px; border-radius: 10px;
}
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.state { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
.waiting .dot { animation: pulse 1.6s ease-in-out infinite; }
.done { color: var(--done); }
.done .dot { background: var(--done); }
.failed { color: var(--danger); }
@keyframes pulse { 50% { opacity: 0.3; } }
@media (prefers-reduced-motion: reduce) { .waiting .dot { animation: none; } }
`

// Runs inside the client's sandboxed frame. It speaks the MCP Apps dialect of JSON-RPC to the
// client over postMessage, and every value it shows goes in as text, never as markup.
const SCRIPT = `
const REFRESH_MS = ${REFRESH_MS};
const root = document.getElementById('card');
let next = 1;
const pending = new Map();
let state = null;
let timer = null;

function send(method, params) {
  const id = next++;
  window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function notify(method, params) {
  window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function day(seconds) {
  return new Date(seconds * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
function stateLine(kind, words) {
  const line = el('p', 'state ' + kind);
  line.append(el('span', 'dot'), el('span', '', words));
  return line;
}
function resize() {
  // The body's own height, which shrinks with its content, unlike the frame's.
  notify('ui/notifications/size-changed', { height: Math.ceil(document.body.getBoundingClientRect().height) });
}

// A request the card shows waiting only moves forward: approved, connected, failed or lapsed. A
// status that knows less, such as from a server that hasn't picked the request up yet, changes
// nothing on the card.
const FORWARD = ['waiting', 'enrolling', 'connected', 'failed'];

// A change request moves on its own until it settles. These are the states it can still leave.
const REQUEST_OPEN = ['waiting', 'approved', 'executing'];
const REQUEST_STATES = {
  approved: ['waiting', 'Approved, waiting for the change to land'],
  executing: ['waiting', 'Landing'],
  active: ['done', 'Active, so your agent can use it'],
  declined: ['failed', 'Declined, so nothing changed'],
  expired: ['failed', 'Lapsed, so nothing changed'],
  stale: ['failed', 'Out of date, so it can never apply'],
  failed: ['failed', "Didn't land, so nothing changed"],
};

// One sale changes no limit. It can be made while approved, once, and is active once made.
const SALE_STATES = {
  approved: ['done', 'Approved, so this one sale can be made'],
  active: ['done', 'Made, so the approval is used up'],
  declined: ['failed', 'Declined'],
  expired: ['failed', 'Lapsed, so it needs asking for again'],
  stale: ['failed', 'Out of date, so it can never be used'],
};

function renderRequest(c) {
  root.append(el('p', 'title', c.change.title));
  for (const row of c.change.rows) {
    // A request that changes nothing that stood before states each fact once.
    const words = 'value' in row ? row.value : row.before + ' now, ' + row.after + ' if approved';
    root.append(el('p', 'text', row.label + ': ' + words));
  }
  if (c.state === 'waiting') {
    root.append(el('p', 'text', 'Only your administrator's passkey approves, on Avow. The link grants nothing by itself.'));
    const actions = el('div', 'actions');
    const open = el('button', '', 'Review on Avow');
    open.type = 'button';
    open.addEventListener('click', () => send('ui/open-link', { url: c.link }).catch(() => {}));
    actions.append(open, stateLine('waiting', 'Waiting for your administrator until ' + day(c.expiresAt)));
    root.append(actions);
  } else {
    const shown = (c.kind === 'sale' ? SALE_STATES : REQUEST_STATES)[c.state] || ['waiting', c.state];
    root.append(stateLine(shown[0], shown[1]));
  }
}

function render(c) {
  if (c && c.id && c.change) {
    // A card shows one request, and a reading of another changes nothing on it.
    if (state && state.id && state.id !== c.id) return;
    state = c;
    root.replaceChildren();
    renderRequest(c);
    resize();
    watch();
    return;
  }
  if (state && state.at === 'waiting' && c && !FORWARD.includes(c.at)) return;
  state = c;
  root.replaceChildren();
  if (!c || !c.at) return;
  if (c.at === 'waiting') {
    root.append(
      el('p', 'title', c.shownLabel + ' asks for authority'),
      el('p', 'text', (c.businessId ? '' : 'Sign in, or set up your business, then approve. ') + 'Approve only if Avow shows this code. The link grants nothing by itself, and only your administrator\\'s passkey approves.'),
      el('p', 'code', c.pairingCode),
    );
    const actions = el('div', 'actions');
    const open = el('button', '', 'Review on Avow');
    open.type = 'button';
    open.addEventListener('click', () => send('ui/open-link', { url: c.link }).catch(() => {}));
    actions.append(open, stateLine('waiting', 'Waiting for approval until ' + day(c.expiresAt)));
    root.append(actions);
  } else if (c.at === 'enrolling') {
    root.append(el('p', 'title', 'Approved'), stateLine('waiting', 'Picking up its authority from Avow'));
  } else if (c.at === 'connected') {
    root.append(
      el('p', 'title', 'Connected'),
      el('p', 'text', 'It can commit for ' + c.businessId + ' within the limits your administrator set, until ' + day(c.expiry) + '.'),
      stateLine('done', 'Approved'),
    );
  } else if (c.at === 'failed') {
    root.append(el('p', 'title', 'Not connected'), el('p', 'text failed', c.reason));
  } else {
    root.append(el('p', 'title', 'Not connected yet'), el('p', 'text', 'Ask your agent to connect to your Avow business.'));
  }
  resize();
  watch();
}

function watch() {
  const live = state && (state.id
    ? REQUEST_OPEN.includes(state.state)
    : state.at === 'waiting' || state.at === 'enrolling');
  if (live && !timer) {
    timer = setInterval(async () => {
      try {
        const call = state.id
          ? { name: 'request_status', arguments: { id: state.id } }
          : { name: 'status', arguments: {} };
        const result = await send('tools/call', call);
        if (result && result.structuredContent) render(result.structuredContent);
      } catch {}
    }, REFRESH_MS);
  } else if (!live && timer) {
    clearInterval(timer);
    timer = null;
  }
}

function theme(context) {
  if (!context) return;
  if (context.theme) document.documentElement.dataset.theme = context.theme;
  const vars = context.styles && context.styles.variables;
  if (vars) for (const [key, value] of Object.entries(vars)) if (value) document.documentElement.style.setProperty(key, value);
}

window.addEventListener('message', (event) => {
  const m = event.data;
  if (!m || m.jsonrpc !== '2.0') return;
  if (m.id !== undefined && pending.has(m.id) && !m.method) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(m.error); else p.resolve(m.result);
    return;
  }
  if (m.method === 'ui/notifications/tool-result') render(m.params && m.params.structuredContent);
  else if (m.method === 'ui/notifications/host-context-changed') theme(m.params);
  else if (m.method === 'ui/resource-teardown') {
    if (timer) clearInterval(timer);
    window.parent.postMessage({ jsonrpc: '2.0', id: m.id, result: {} }, '*');
  }
});

send('ui/initialize', {
  appInfo: { name: 'avow-sandbox-approval', version: '1' },
  appCapabilities: {},
  protocolVersion: '2026-01-26',
}).then((result) => {
  theme(result && result.hostContext);
  notify('ui/notifications/initialized', {});
}).catch(() => {});
`

/** The card's page, one self-contained file with no outside scripts, styles or fonts. */
export function approvalCardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Avow approval</title>
<style>${STYLE}</style>
</head>
<body>
<main id="card" aria-live="polite"></main>
<script>${SCRIPT}</script>
</body>
</html>`
}
