// The page a logged-out visitor gets in place of the dashboard: a token form
// and a link home. The server serves the real dashboard at the same URL once
// the session cookie is set, so logging in is just a reload, and the hash
// (the page someone asked for) carries through.

import { loadAnalytics } from "/analytics.js";

const form = document.getElementById("login-form");
const input = document.getElementById("login-token");
const button = form.querySelector("button");
const error = document.getElementById("login-error");
const home = document.getElementById("home-link");

function showError(message) {
  error.textContent = message;
  error.hidden = false;
}

async function loadSession() {
  let session;
  try {
    const response = await fetch("/api/session", { credentials: "same-origin" });
    session = await response.json();
  } catch {
    showError("Can't reach the dispatcher.");
    return;
  }
  // Logged in from another tab, or the cookie is still good.
  if (session.authenticated) {
    location.reload();
    return;
  }
  loadAnalytics(session.analytics);
  if (session.homeUrl) {
    home.href = session.homeUrl;
    try {
      home.textContent = `← ${new URL(session.homeUrl).host}`;
    } catch {
      home.textContent = "← Home";
    }
    home.hidden = false;
  }
  if (!session.loginEnabled) {
    input.disabled = true;
    button.disabled = true;
    showError("Login is disabled: set DASHBOARD_TOKEN on the dispatcher.");
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  button.disabled = true;
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: input.value }),
      credentials: "same-origin",
    });
    if (response.ok) {
      location.reload();
      return;
    }
    const data = await response.json().catch(() => ({}));
    showError(data.error ?? `${response.status} ${response.statusText}`);
    input.select();
  } catch {
    showError("Can't reach the dispatcher.");
  } finally {
    button.disabled = false;
  }
});

void loadSession();
