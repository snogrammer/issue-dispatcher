// IssueDispatcher dashboard: a small hash-routed app with no build step and
// no dependencies. Every value from the API goes into the DOM as text (never
// innerHTML), so issue titles, branch names and log lines can't inject markup.
//
// The server only hands this out to a logged-in browser (others get
// landing.html), so there's no logged-out state here: once the session ends,
// reloading brings the landing page back.

import { loadAnalytics } from "/analytics.js";

const view = document.getElementById("view");
const toastEl = document.getElementById("toast");

/** @type {{ authenticated: boolean, homeUrl: string | null, analytics: { src: string, domain: string | null } | null, configEditable: boolean, version: string, giteaUrl: string, botUsername: string, humanReviewer: string } | null} */
let session = null;
/** Cleanup for the page being shown (timers, event streams). */
let teardown = () => {};
/** Bumped on every navigation so a slow load can't paint over a newer page. */
let generation = 0;

// --- DOM helpers ---------------------------------------------------------------

/**
 * h("a", { href, class: "x", onclick }, "text", child) → element. Strings and
 * numbers become text nodes; null/false children are skipped.
 */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (key in el && key !== "list") el[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return append(el, children);
}

function toast(message, bad = false) {
  toastEl.textContent = message;
  toastEl.className = bad ? "toast bad" : "toast";
  toastEl.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (toastEl.hidden = true), bad ? 6000 : 3000);
}

// --- Formatting ----------------------------------------------------------------

const usd = (n) =>
  n === null || n === undefined
    ? "—"
    : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 3 : 2 })}`;
const runCount = (n) => `${num(n)} run${n === 1 ? "" : "s"}`;
const num = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString());

function duration(ms) {
  if (ms < 0) ms = 0;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ${min % 60}m`;
  return `${Math.floor(hr / 24)}d ${hr % 24}h`;
}

const ago = (iso) => (iso ? `${duration(Date.now() - new Date(iso).getTime())} ago` : "—");
const until = (iso) => duration(new Date(iso).getTime() - Date.now());
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

function runDuration(run) {
  const end = run.endedAt ? new Date(run.endedAt).getTime() : Date.now();
  return duration(end - new Date(run.startedAt).getTime());
}

const pill = (text, kind = text) => h("span", { class: `pill ${kind ?? ""}` }, text ?? "—");

// --- Links into Gitea ------------------------------------------------------------

const giteaBase = () => session?.giteaUrl ?? "";
const repoLink = (repo) =>
  h("a", { href: `${giteaBase()}/${repo}`, target: "_blank", rel: "noreferrer" }, repo);
const issueLink = (repo, issue, text = `#${issue}`) =>
  h(
    "a",
    { href: `${giteaBase()}/${repo}/issues/${issue}`, target: "_blank", rel: "noreferrer" },
    text,
  );
const prLink = (repo, pr) =>
  h(
    "a",
    { href: `${giteaBase()}/${repo}/pulls/${pr}`, target: "_blank", rel: "noreferrer" },
    `!${pr}`,
  );
const workLink = (repo, issue, text) => h("a", { href: `#/work/${repo}/${issue}` }, text);

// --- API -------------------------------------------------------------------------

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await response.json().catch(() => ({}));
  // Logged out elsewhere, or the token was rotated.
  if (response.status === 401) sessionEnded();
  if (!response.ok) {
    const error = new Error(data.error ?? `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

/** The server serves the landing page in place of the dashboard now. */
function sessionEnded() {
  location.reload();
}

async function loadSession() {
  try {
    session = await api("/api/session");
  } catch {
    session = null;
  }
  if (session && !session.authenticated) sessionEnded();
  loadAnalytics(session?.analytics);
  renderSession();
}

/** Run a write and report the outcome. */
async function write(label, path, options = { method: "POST" }) {
  try {
    const result = await api(path, options);
    toast(label);
    return result;
  } catch (error) {
    toast(error.message, true);
    throw error;
  }
}

/** A control action button's handler: run it, then repaint (errors were already shown). */
const act = (label, path) => () => write(label, path).then(route, () => {});

// --- Sidebar: health and session -------------------------------------------------

function renderHealth(status) {
  const el = document.getElementById("health");
  el.replaceChildren();
  if (!status) {
    append(el, [h("span", { class: "dot bad" }), h("span", {}, "Unreachable")]);
    return;
  }
  const ok = status.health.ok;
  append(el, [
    h("span", { class: `dot ${ok ? "ok" : "bad"}` }),
    h("span", {}, ok ? "Healthy" : `Stale ${duration(status.health.staleSeconds * 1000)}`),
    h("span", { class: "muted" }, `v${status.version}`),
  ]);
}

function renderSession() {
  const el = document.getElementById("session");
  el.replaceChildren();
  if (session?.homeUrl) {
    el.append(h("a", { href: session.homeUrl, rel: "noreferrer" }, `← ${hostOf(session.homeUrl)}`));
  }
  el.append(
    h(
      "button",
      {
        type: "button",
        onclick: async () => {
          await api("/api/logout", { method: "POST" }).catch(() => {});
          location.assign("/");
        },
      },
      "Log out",
    ),
  );
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// --- Shared pieces -------------------------------------------------------------------

function table(headers, rows, empty = "Nothing here yet.") {
  if (rows.length === 0) return h("p", { class: "empty" }, empty);
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      {},
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          headers.map((head) => h("th", { class: head.num ? "num" : "" }, head.label ?? head)),
        ),
      ),
      h("tbody", {}, rows),
    ),
  );
}

function tile(label, value, sub) {
  return h(
    "div",
    { class: "card tile" },
    h("div", { class: "label" }, label),
    h("div", { class: "value" }, value),
    sub ? h("div", { class: "sub" }, sub) : null,
  );
}

const RUN_HEADERS = [
  "Run",
  "Issue",
  "Phase",
  "Model",
  "Effort",
  "Started",
  "Took",
  "Exit",
  { label: "Cost", num: true },
  { label: "Tokens in/out", num: true },
];

function runRows(runs, { showIssue = true } = {}) {
  return runs.flatMap((run) => {
    const row = h(
      "tr",
      {},
      h("td", { class: "mono" }, run.id),
      h(
        "td",
        {},
        showIssue
          ? [
              h("span", { class: "muted" }, `${run.repo} `),
              workLink(run.repo, run.issue, `#${run.issue}`),
            ]
          : `#${run.issue}`,
      ),
      h("td", {}, run.phase),
      h("td", {}, run.model ?? h("span", { class: "muted" }, "default")),
      h("td", {}, run.effort ?? h("span", { class: "muted" }, "default")),
      h("td", { title: when(run.startedAt) }, ago(run.startedAt)),
      h("td", {}, runDuration(run)),
      h("td", {}, run.exit ? pill(run.exit) : pill("running")),
      h("td", { class: "num" }, usd(run.costUsd)),
      h(
        "td",
        { class: "num" },
        run.inputTokens === undefined && run.outputTokens === undefined
          ? "—"
          : `${num(run.inputTokens)} / ${num(run.outputTokens)}`,
      ),
    );
    return run.error
      ? [row, h("tr", { class: "detail" }, h("td", { colSpan: RUN_HEADERS.length }, run.error))]
      : [row];
  });
}

function workRows(work) {
  return work.map((item) =>
    h(
      "tr",
      {},
      h("td", {}, repoLink(item.repo)),
      h(
        "td",
        {},
        workLink(item.repo, item.issue, `#${item.issue}`),
        " ",
        issueLink(item.repo, item.issue, "Gitea ↗"),
      ),
      h("td", {}, pill(item.state)),
      h("td", { class: "mono" }, item.branch ?? "—"),
      h(
        "td",
        {},
        item.pullRequests.length
          ? item.pullRequests.map((pr, i) => [i ? " " : "", prLink(item.repo, pr)])
          : "—",
      ),
      h("td", { class: "num" }, item.fixAttempts),
      h("td", { title: when(item.updatedAt) }, ago(item.updatedAt)),
    ),
  );
}

const WORK_HEADERS = [
  "Repo",
  "Issue",
  "State",
  "Branch",
  "PRs",
  { label: "Fix rounds", num: true },
  "Updated",
];

// --- Overview -------------------------------------------------------------------------

async function overviewPage(gen) {
  const status = await api("/status");
  if (gen !== generation) return;
  renderHealth(status);
  const { pauses, sessions, costs, work, running } = status;

  const actions = [
    h(
      "button",
      { type: "button", onclick: act("Polling now", "/api/actions/poll-now") },
      "Poll now",
    ),
    pauses.manual
      ? h(
          "button",
          {
            type: "button",
            class: "primary",
            onclick: act("Pickups resumed", "/api/actions/resume-pickups"),
          },
          "Resume pickups",
        )
      : h(
          "button",
          {
            type: "button",
            class: "danger",
            onclick: act("Pickups paused", "/api/actions/pause-pickups"),
          },
          "Pause pickups",
        ),
  ];

  const banners = [];
  const clear = h(
    "button",
    { type: "button", onclick: act("Usage pause cleared", "/api/actions/clear-usage-pause") },
    "Clear pause",
  );
  if (pauses.manual) {
    banners.push(
      h(
        "div",
        { class: "banner warn" },
        h("strong", {}, "Pickups paused from the dashboard."),
        h(
          "span",
          { class: "grow" },
          "Work already in progress continues; no new issues are started.",
        ),
      ),
    );
  }
  if (pauses.usageLimitUntil && new Date(pauses.usageLimitUntil) > new Date()) {
    banners.push(
      h(
        "div",
        { class: "banner warn" },
        h(
          "strong",
          {},
          pauses.reason === "auth" ? "Claude Code can't authenticate." : "Usage limit reached.",
        ),
        h(
          "span",
          { class: "grow" },
          `No runs start until ${when(pauses.usageLimitUntil)} (in ${until(pauses.usageLimitUntil)}). Backoff level ${pauses.backoffLevel}.`,
          pauses.reason === "auth"
            ? " Fix CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY and redeploy (that lifts the pause), or clear it to retry now."
            : null,
        ),
        clear,
      ),
    );
  }
  if (pauses.pickupsUntil && new Date(pauses.pickupsUntil) > new Date()) {
    banners.push(
      h(
        "div",
        { class: "banner info" },
        h("strong", {}, "Close to the usage limit."),
        h(
          "span",
          { class: "grow" },
          `New issues wait until ${when(pauses.pickupsUntil)} (in ${until(pauses.pickupsUntil)}).`,
        ),
        clear,
      ),
    );
  }
  if (pauses.ciBusy) {
    banners.push(
      h(
        "div",
        { class: "banner info" },
        h("strong", {}, "CI is backed up."),
        h("span", { class: "grow" }, "Runs start again once Actions has room."),
      ),
    );
  }

  const byState = {};
  for (const item of work) byState[item.state] = (byState[item.state] ?? 0) + 1;
  const stateSummary = Object.entries(byState)
    .map(([state, count]) => `${count} ${state}`)
    .join(" · ");

  return [
    h(
      "div",
      { class: "page-head" },
      h("h1", {}, "Overview"),
      pill(status.health.ok ? "healthy" : "stale", status.health.ok ? "ok" : "bad"),
      h(
        "span",
        { class: "muted" },
        status.health.lastTickAt
          ? `Last poll ${ago(status.health.lastTickAt)}`
          : "Waiting for the first poll",
      ),
      h("span", { class: "spacer" }),
      actions,
    ),
    banners,
    h(
      "div",
      { class: "grid tiles" },
      tile("Sessions", `${sessions.running} / ${sessions.max}`, "Claude runs in progress"),
      tile("Held issues", work.length, stateSummary || "none"),
      tile("Watching", status.repos.length, status.repos.length === 1 ? "repo" : "repos"),
      tile("Cost 24h", usd(costs.last24h.costUsd), `${runCount(costs.last24h.runs)}`),
      tile("Cost 7d", usd(costs.last7d.costUsd), `${runCount(costs.last7d.runs)}`),
      tile(
        "All time",
        usd(costs.allTime.costUsd),
        `${runCount(costs.allTime.runs)} · up ${status.startedAt ? duration(Date.now() - new Date(status.startedAt).getTime()) : "—"}`,
      ),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Running now"),
      table(
        ["Repo", "Issue", "Phase", "Running for"],
        running.map((run) =>
          h(
            "tr",
            {},
            h("td", {}, repoLink(run.repo)),
            h("td", {}, workLink(run.repo, run.issue, `#${run.issue}`)),
            h("td", {}, pill(run.phase, "running")),
            h("td", {}, duration(Date.now() - new Date(run.startedAt).getTime())),
          ),
        ),
        "No Claude runs in progress.",
      ),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Held work"),
      table(WORK_HEADERS, workRows(work), "No issues held. Assign one to the bot to start."),
    ),
    h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "row" },
        h("h2", {}, "Recent runs"),
        h("span", { class: "spacer" }),
        h("a", { href: "#/runs" }, "All runs →"),
      ),
      table(RUN_HEADERS, runRows(status.recentRuns.slice(0, 10)), "No runs yet."),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Watched repos"),
      status.repos.length
        ? h(
            "div",
            { class: "row" },
            status.repos.map((repo) => h("span", { class: "pill" }, repoLink(repo))),
          )
        : h("p", { class: "empty" }, "No repos found yet."),
      (status.skippedRepos ?? []).length
        ? h(
            "div",
            {},
            h("h3", {}, "Not watching"),
            h(
              "div",
              { class: "row" },
              status.skippedRepos.map((skip) =>
                h(
                  "span",
                  { class: "pill warn", title: skip.reason },
                  `${skip.name}: ${skip.reason}`,
                ),
              ),
            ),
          )
        : null,
    ),
  ];
}

// --- Work ----------------------------------------------------------------------------------

async function workPage(gen) {
  const status = await api("/status");
  if (gen !== generation) return;
  renderHealth(status);
  return [
    h(
      "div",
      { class: "page-head" },
      h("h1", {}, "Work"),
      h(
        "span",
        { class: "muted" },
        `Issues assigned to ${session?.botUsername ?? "the bot"} that it is holding`,
      ),
    ),
    h(
      "div",
      { class: "card" },
      table(WORK_HEADERS, workRows(status.work), "No issues held right now."),
    ),
  ];
}

async function workDetailPage(gen, repo, issue) {
  const data = await api(`/api/work/${repo}/${issue}`);
  if (gen !== generation) return;
  const work = data.work;
  const total = data.runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
  const facts = work
    ? [
        ["State", pill(work.state)],
        ["Branch", h("span", { class: "mono" }, work.branch ?? "—")],
        [
          "Pull requests",
          work.prStack.length
            ? work.prStack.map((pr, i) => [i ? " → " : "", prLink(repo, pr)])
            : "—",
        ],
        ["Fix rounds", work.fixAttempts],
        ["Head", h("span", { class: "mono" }, work.lastSha ? work.lastSha.slice(0, 10) : "—")],
        ["Session", h("span", { class: "mono" }, work.sessionId ?? "—")],
        ["Started", when(work.createdAt)],
        ["Updated", `${when(work.updatedAt)} (${ago(work.updatedAt)})`],
      ]
    : [["State", h("span", { class: "muted" }, "No longer held; run history below.")]];
  return [
    h(
      "div",
      { class: "page-head" },
      h("a", { href: "#/work" }, "← Work"),
      h("h1", {}, `${repo} #${issue}`),
      issueLink(repo, issue),
      h("span", { class: "spacer" }),
      h("span", { class: "muted" }, `${runCount(data.runs.length)} · ${usd(total)}`),
    ),
    h(
      "div",
      { class: "card" },
      h(
        "table",
        {},
        h(
          "tbody",
          {},
          facts.map(([label, value]) =>
            h("tr", {}, h("th", {}, label), h("td", { class: "wrap" }, value)),
          ),
        ),
      ),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Runs"),
      table(RUN_HEADERS, runRows(data.runs, { showIssue: false }), "No runs recorded."),
    ),
  ];
}

// --- Runs & costs ------------------------------------------------------------------------

const PHASES = ["implement", "fix-ci", "address-review", "rebase"];
const EXITS = ["success", "error", "timeout", "rate_limited", "aborted", "running"];

function dayChart(byDay, since, days) {
  const values = new Map(byDay.map((d) => [d.day, d]));
  const bars = [];
  const start = new Date(since).getTime();
  for (let i = 0; i < days; i++) {
    const day = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    bars.push({ day, cost: values.get(day)?.costUsd ?? 0, runs: values.get(day)?.runs ?? 0 });
  }
  const max = Math.max(...bars.map((b) => b.cost), 0.01);
  const W = 720;
  const H = 180;
  const pad = { l: 44, r: 8, t: 10, b: 22 };
  const bw = (W - pad.l - pad.r) / bars.length;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  return h(
    "div",
    { class: "chart" },
    s(
      "svg",
      {
        viewBox: `0 0 ${W} ${H}`,
        role: "img",
        "aria-label": `Daily cost over the last ${days} days`,
      },
      [0, 0.5, 1].map((f) => [
        s("line", { class: "grid-line", x1: pad.l, x2: W - pad.r, y1: y(max * f), y2: y(max * f) }),
        s(
          "text",
          { class: "axis", x: pad.l - 6, y: y(max * f) + 4, "text-anchor": "end" },
          usd(max * f),
        ),
      ]),
      bars.map((b, i) =>
        s(
          "rect",
          {
            class: "bar",
            x: pad.l + i * bw + 1,
            y: y(b.cost),
            width: Math.max(bw - 2, 1),
            height: Math.max(H - pad.b - y(b.cost), b.cost > 0 ? 1 : 0),
            rx: 2,
          },
          s("title", {}, `${b.day}: ${usd(b.cost)} · ${runCount(b.runs)}`),
        ),
      ),
      s("text", { class: "axis", x: pad.l, y: H - 6 }, bars[0]?.day ?? ""),
      s(
        "text",
        { class: "axis", x: W - pad.r, y: H - 6, "text-anchor": "end" },
        bars.at(-1)?.day ?? "",
      ),
    ),
  );
}

function hbars(items) {
  if (items.length === 0) return h("p", { class: "empty" }, "No runs in this period.");
  const max = Math.max(...items.map((i) => i.costUsd), 0.0001);
  return h(
    "div",
    { class: "hbars" },
    items.map((item) => {
      const fill = h("div", { class: "fill" });
      fill.style.width = `${Math.max((item.costUsd / max) * 100, item.costUsd > 0 ? 1 : 0)}%`;
      return h(
        "div",
        { class: "hbar" },
        h(
          "div",
          { class: "top" },
          h("span", {}, item.label),
          h(
            "span",
            { class: "muted" },
            `${usd(item.costUsd)} · ${runCount(item.runs)} · ${num(item.inputTokens + item.outputTokens)} tok`,
          ),
        ),
        h("div", { class: "track" }, fill),
      );
    }),
  );
}

async function runsPage(gen, query) {
  const days = Number(query.get("days") ?? 30);
  const filters = Object.fromEntries(
    ["repo", "phase", "exit", "model"].map((k) => [k, query.get(k) ?? ""]),
  );
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== ""));
  qs.set("limit", "50");
  const [costs, page, status] = await Promise.all([
    api(`/api/costs?days=${days}`),
    api(`/api/runs?${qs}`),
    api("/status"),
  ]);
  if (gen !== generation) return;
  renderHealth(status);

  const tbody = h("tbody", {}, runRows(page.runs));
  let next = page.next;
  const moreButton = h(
    "button",
    {
      type: "button",
      hidden: page.runs.length < 50,
      onclick: async () => {
        const params = new URLSearchParams(qs);
        params.set("before", String(next));
        try {
          const older = await api(`/api/runs?${params}`);
          append(tbody, runRows(older.runs));
          next = older.next;
          if (older.runs.length < 50) moreButton.hidden = true;
        } catch (error) {
          toast(error.message, true);
        }
      },
    },
    "Load more",
  );

  const setFilter = (key, value) => {
    const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
    if (value) params.set(key, value);
    else params.delete(key);
    location.hash = `#/runs?${params}`;
  };
  const select = (key, options, label) =>
    h(
      "select",
      { "aria-label": label, onchange: (e) => setFilter(key, e.target.value) },
      h("option", { value: "" }, `All ${label}`),
      options.map((o) => h("option", { value: o, selected: filters[key] === o }, o)),
    );
  const repos = [...new Set([...status.repos, ...costs.byRepo.map((r) => r.repo)])].sort();

  return [
    h(
      "div",
      { class: "page-head" },
      h("h1", {}, "Runs & costs"),
      h("span", { class: "spacer" }),
      h(
        "select",
        { "aria-label": "Period", onchange: (e) => setFilter("days", e.target.value) },
        [7, 30, 90].map((d) => h("option", { value: d, selected: d === days }, `Last ${d} days`)),
      ),
    ),
    h(
      "div",
      { class: "grid tiles" },
      tile(`Cost, ${days}d`, usd(costs.total.costUsd), `${runCount(costs.total.runs)}`),
      tile("Avg per run", usd(costs.total.runs ? costs.total.costUsd / costs.total.runs : 0)),
      tile("Input tokens", num(costs.total.inputTokens)),
      tile("Output tokens", num(costs.total.outputTokens)),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Daily cost"),
      dayChart(costs.byDay, costs.since, costs.days),
    ),
    h(
      "div",
      { class: "grid two" },
      h(
        "div",
        { class: "card" },
        h("h2", {}, "By repo"),
        hbars(costs.byRepo.map((r) => ({ ...r, label: r.repo }))),
      ),
      h(
        "div",
        { class: "card" },
        h("h2", {}, "By model"),
        hbars(costs.byModel.map((m) => ({ ...m, label: m.model ?? "CLI default" }))),
      ),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Run history"),
      h(
        "div",
        { class: "filters" },
        select("repo", repos, "repos"),
        select("phase", PHASES, "phases"),
        select("exit", EXITS, "exits"),
        h("input", {
          type: "search",
          placeholder: "Model (exact)",
          value: filters.model,
          "aria-label": "Model",
          onchange: (e) => setFilter("model", e.target.value.trim()),
        }),
      ),
      page.runs.length
        ? h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              {},
              h(
                "thead",
                {},
                h(
                  "tr",
                  {},
                  RUN_HEADERS.map((head) =>
                    h("th", { class: head.num ? "num" : "" }, head.label ?? head),
                  ),
                ),
              ),
              tbody,
            ),
          )
        : h("p", { class: "empty" }, "No runs match."),
      h("div", { class: "row end" }, moreButton),
    ),
  ];
}

// --- Config -------------------------------------------------------------------------------------

function sourceBadge(source) {
  const labels = { dashboard: "dashboard", env: "env", file: "file", default: "default" };
  return h(
    "span",
    { class: `source ${source}`, title: `Value comes from: ${source}` },
    labels[source] ?? source,
  );
}

/** Display form of a value for an input. */
function formValue(entry, value) {
  if (value === null || value === undefined) return "";
  if (entry.type === "list") return value.join(", ");
  if (entry.type === "json") return JSON.stringify(value, null, 2);
  return String(value);
}

/** Parse an input's text back into a value; throws with a message on bad input. */
function parseValue(entry, raw) {
  const text = typeof raw === "string" ? raw.trim() : raw;
  switch (entry.type) {
    case "bool":
      return Boolean(raw);
    case "int":
    case "number": {
      if (text === "") {
        if (entry.nullable) return null;
        throw new Error(`${entry.key} needs a value`);
      }
      const n = Number(text);
      if (!Number.isFinite(n) || (entry.type === "int" && !Number.isInteger(n)))
        throw new Error(
          `${entry.key} must be ${entry.type === "int" ? "a whole number" : "a number"}`,
        );
      return n;
    }
    case "enum":
      return text === "" ? null : text;
    case "list":
      return text === ""
        ? []
        : text
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
    case "json":
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new Error(`${entry.key}: invalid JSON (${error.message})`, { cause: error });
      }
  }
  return text;
}

async function configPage(gen) {
  if (session && !session.configEditable) {
    return [
      h("div", { class: "page-head" }, h("h1", {}, "Config")),
      h("p", { class: "empty" }, "Config isn't available from this server."),
    ];
  }
  const config = await api("/api/config");
  if (gen !== generation) return;

  /** Working copy of the override document. */
  const overrides = structuredClone(config.overrides);
  const original = JSON.stringify(overrides);
  const status = h("span", { class: "muted" });
  const errors = h("p", { class: "error", hidden: true });
  const saveButton = h(
    "button",
    { type: "submit", class: "primary", disabled: true },
    "Save & apply",
  );
  const discard = h(
    "button",
    { type: "button", class: "ghost", onclick: route, disabled: true },
    "Discard",
  );
  const fields = new Map();

  const dirty = () => {
    const changed = JSON.stringify(overrides) !== original;
    saveButton.disabled = !changed;
    discard.disabled = !changed;
    status.textContent = changed
      ? "Unsaved changes. Saved values apply to the running dispatcher without a restart."
      : "Values set here override env and the config file.";
    for (const [key, field] of fields)
      field.classList.toggle(
        "changed",
        JSON.stringify(overrides[key]) !== JSON.stringify(config.overrides[key]),
      );
  };

  const field = (entry) => {
    const overridden = Object.hasOwn(overrides, entry.key);
    const value = overridden ? overrides[entry.key] : entry.value;
    const onInput = (raw) => {
      try {
        overrides[entry.key] = parseValue(entry, raw);
        errors.hidden = true;
      } catch (error) {
        errors.textContent = error.message;
        errors.hidden = false;
      }
      dirty();
    };
    let control;
    if (entry.type === "bool") {
      control = h("input", {
        type: "checkbox",
        checked: Boolean(value),
        onchange: (e) => onInput(e.target.checked),
        "aria-label": entry.key,
      });
    } else if (entry.type === "enum") {
      control = h(
        "select",
        { onchange: (e) => onInput(e.target.value), "aria-label": entry.key },
        entry.nullable ? h("option", { value: "" }, "(unset)") : null,
        entry.options.map((o) => h("option", { value: o, selected: value === o }, o)),
      );
    } else if (entry.type === "json") {
      control = h("textarea", {
        oninput: (e) => onInput(e.target.value),
        "aria-label": entry.key,
        value: formValue(entry, value),
      });
      control.spellcheck = false;
    } else {
      control = h("input", {
        type: entry.type === "list" ? "text" : "number",
        step: entry.type === "number" ? "any" : "1",
        min: entry.min,
        max: entry.max,
        placeholder: entry.nullable ? "(unset)" : "",
        value: formValue(entry, value),
        oninput: (e) => onInput(e.target.value),
        "aria-label": entry.key,
      });
    }
    const reset = overridden
      ? h(
          "button",
          {
            type: "button",
            class: "ghost",
            title: "Remove the dashboard override and use env/file/default",
            onclick: () => {
              Reflect.deleteProperty(overrides, entry.key);
              dirty();
              reset.disabled = true;
              reset.textContent = "Reset on save";
            },
          },
          "Reset",
        )
      : null;
    const el = h(
      "div",
      { class: "field" },
      h(
        "div",
        { class: "meta" },
        h(
          "div",
          { class: "row" },
          h("span", { class: "key" }, entry.key),
          sourceBadge(entry.source),
        ),
        h(
          "span",
          { class: "help" },
          entry.help,
          entry.env ? [" · ", h("code", {}, entry.env)] : null,
        ),
      ),
      h("div", { class: "control" }, control, reset),
    );
    fields.set(entry.key, el);
    return el;
  };

  const groups = new Map();
  for (const entry of config.editable) {
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push(entry);
  }

  const form = h(
    "form",
    {
      onsubmit: async (event) => {
        event.preventDefault();
        if (!errors.hidden) return;
        saveButton.disabled = true;
        try {
          const result = await write("Saved", "/api/config", {
            method: "PUT",
            body: { overrides },
          });
          toast(
            result.changed.length
              ? `Applied: ${result.changed.join(", ")}`
              : "Saved; nothing changed",
          );
          route();
        } catch (error) {
          errors.textContent = error.message;
          errors.hidden = false;
          dirty();
        }
      },
    },
    [...groups].map(([group, entries]) =>
      h("div", { class: "card" }, h("h2", {}, group), entries.map(field)),
    ),
    h(
      "div",
      { class: "savebar" },
      h("div", { class: "grow" }, status, errors),
      discard,
      saveButton,
    ),
  );
  queueMicrotask(dirty);

  return [
    h(
      "div",
      { class: "page-head" },
      h("h1", {}, "Config"),
      h(
        "span",
        { class: "muted" },
        config.configFile ? `File: ${config.configFile}` : "No config file",
      ),
    ),
    form,
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Set in env or the config file"),
      h(
        "p",
        { class: "muted" },
        "Identity, paths, the status server and secrets need a restart to change, so they're read-only here.",
      ),
      table(
        ["Key", "Env var", "Value", "Source"],
        config.readOnly.map((item) =>
          h(
            "tr",
            {},
            h("td", { class: "mono" }, item.key),
            h("td", { class: "mono muted" }, item.env),
            h(
              "td",
              { class: "mono wrap" },
              item.secret
                ? item.value === null
                  ? "unset"
                  : "set (hidden)"
                : item.value === null
                  ? h("span", { class: "muted" }, "unset")
                  : Array.isArray(item.value)
                    ? item.value.join(", ")
                    : String(item.value),
            ),
            h("td", {}, sourceBadge(item.source)),
          ),
        ),
      ),
    ),
  ];
}

// --- Logs ----------------------------------------------------------------------------------------

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];

function logsPage() {
  const box = h("div", { class: "logs", role: "log", "aria-live": "off" });
  let minLevel = "debug";
  let search = "";
  let paused = false;
  const MAX = 1000;

  const lineEl = (raw) => {
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      entry = { msg: raw };
    }
    const { time, level, msg, ...fields } = entry;
    const extra = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
    const el = h(
      "div",
      { class: "log-line" },
      h("span", { class: "t", title: time ?? "" }, time ? new Date(time).toLocaleTimeString() : ""),
      h("span", { class: `lv ${level ?? ""}` }, level ?? ""),
      h("span", { class: "m" }, msg ?? "", h("span", { class: "f" }, extra)),
    );
    el.dataset.level = level ?? "info";
    el.dataset.text = raw.toLowerCase();
    return el;
  };
  const visible = (el) =>
    LEVELS.indexOf(el.dataset.level) >= LEVELS.indexOf(minLevel) &&
    (search === "" || el.dataset.text.includes(search));
  const refilter = () => {
    for (const el of box.children) el.hidden = !visible(el);
  };
  const add = (raw) => {
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const el = lineEl(raw);
    el.hidden = !visible(el);
    box.append(el);
    while (box.children.length > MAX) box.firstChild.remove();
    if (atBottom && !paused) box.scrollTop = box.scrollHeight;
  };

  const pending = [];
  const source = new EventSource("/api/logs/stream");
  source.onmessage = (event) => {
    if (paused) pending.push(event.data);
    else add(event.data);
  };
  // A 401 closes the stream for good; network blips reconnect on their own.
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) void loadSession();
  };
  api("/api/logs")
    .then((data) => {
      for (const line of data.lines) add(line);
      box.scrollTop = box.scrollHeight;
    })
    .catch((error) => toast(error.message, true));
  teardown = () => source.close();

  const pauseButton = h(
    "button",
    {
      type: "button",
      onclick: () => {
        paused = !paused;
        pauseButton.textContent = paused ? "Resume" : "Pause";
        if (!paused) {
          for (const line of pending.splice(0)) add(line);
          box.scrollTop = box.scrollHeight;
        }
      },
    },
    "Pause",
  );

  return [
    h(
      "div",
      { class: "page-head" },
      h("h1", {}, "Logs"),
      h(
        "span",
        { class: "muted" },
        "Live, newest at the bottom. Secrets are redacted before they get here.",
      ),
      h("span", { class: "spacer" }),
      h(
        "select",
        {
          "aria-label": "Minimum level",
          onchange: (e) => {
            minLevel = e.target.value;
            refilter();
          },
        },
        LEVELS.slice(1).map((level) =>
          h("option", { value: level, selected: level === minLevel }, `${level}+`),
        ),
      ),
      h("input", {
        type: "search",
        placeholder: "Filter text",
        "aria-label": "Filter text",
        oninput: (e) => {
          search = e.target.value.toLowerCase();
          refilter();
        },
      }),
      pauseButton,
      h(
        "button",
        { type: "button", class: "ghost", onclick: () => box.replaceChildren() },
        "Clear",
      ),
    ),
    box,
  ];
}

// --- Router ----------------------------------------------------------------------------------------

const REFRESH_MS = 5000;

function parseHash() {
  const [path, qs] = location.hash.replace(/^#/, "").split("?");
  const parts = (path || "/").split("/").filter(Boolean);
  return { parts, query: new URLSearchParams(qs ?? "") };
}

async function route() {
  teardown();
  teardown = () => {};
  const gen = ++generation;
  const { parts, query } = parseHash();
  const page = parts[0] ?? "overview";

  for (const link of document.querySelectorAll(".nav a"))
    link.classList.toggle("active", link.dataset.page === page);

  let render;
  let refresh = false;
  switch (page) {
    case "overview":
      render = () => overviewPage(gen);
      refresh = true;
      break;
    case "work":
      if (parts.length === 4)
        render = () => workDetailPage(gen, `${parts[1]}/${parts[2]}`, parts[3]);
      else render = () => workPage(gen);
      refresh = true;
      break;
    case "runs":
      render = () => runsPage(gen, query);
      break;
    case "config":
      render = () => configPage(gen);
      break;
    case "logs":
      render = async () => logsPage();
      break;
    default:
      render = async () => [
        h("h1", {}, "Not found"),
        h("p", {}, h("a", { href: "#/" }, "Back to the overview")),
      ];
  }

  const paint = async (first) => {
    try {
      const nodes = await render();
      if (gen !== generation || nodes === undefined) return;
      const scroll = window.scrollY;
      view.replaceChildren(...[nodes].flat(Infinity).filter(Boolean));
      if (!first) window.scrollTo(0, scroll);
    } catch (error) {
      if (gen !== generation) return;
      if (first)
        view.replaceChildren(
          h("h1", {}, "Couldn't load this page"),
          h("p", { class: "error" }, error.message),
        );
      renderHealth(null);
    }
  };

  await paint(true);
  if (refresh) {
    const timer = setInterval(() => {
      // Don't repaint under someone selecting text.
      if (!document.hidden && String(window.getSelection() ?? "") === "") void paint(false);
    }, REFRESH_MS);
    const previous = teardown;
    teardown = () => {
      clearInterval(timer);
      previous();
    };
  }
}

/**
 * Keep the sidebar's health dot current on every page, not just the ones that
 * fetch /status. /healthz answers 503 with the same body when stale.
 */
async function refreshHealth() {
  try {
    const response = await fetch("/healthz");
    const health = await response.json();
    renderHealth({ health, version: session?.version ?? "?" });
  } catch {
    renderHealth(null);
  }
}

window.addEventListener("hashchange", route);
await loadSession();
route();
void refreshHealth();
setInterval(() => void refreshHealth(), 10_000);
