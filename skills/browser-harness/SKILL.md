---
name: browser
description: |
  MUST use for any user request involving Chrome, browser, webpage/page, URL, open a site/link, click/type, screenshot, scrape/inspect, web UI testing, or current/logged-in browser session. Use single CLI chrome-harness: if Chrome is already running it connects to that same/default profile; if Chrome is not running it launches headless Chrome with the same/default profile, then connects. Do not use Playwright/Puppeteer/Node/open/osascript/AppleScript/hardcoded CDP ports. Write helper-snippet Python in ~/.pi/agent/browser-harness/ with new_tab(), wait_for_load(), page_info(), js(), capture_screenshot(), click_at_xy(), type_text(); create files with write/patch/cat, not $EDITOR; run `chrome-harness < script.py`.
---

# browser-harness

Direct browser control via CDP. For task-specific edits, use `agent-workspace/agent_helpers.py`. For setup, install, or connection problems, read install.md.

## Sharath's local setup — REQUIRED

Use single CLI `chrome-harness` for browser automation.

`chrome-harness` policy for Sharath:
- If normal Chrome is already running and CDP is live, connect to that live/default profile.
- Otherwise launch/reuse headless Chrome for Testing with a separate persistent automation profile under `~/.pi/agent/chrome-profiles/headless-default`, then connect via CDP. This avoids blocking Dock Chrome.

Visible Chrome can steal focus because CDP `Target.activateTarget` focuses tabs. Headless Chrome for Testing does not show in the macOS Dock.

Do **not** use Helium, Browser Use cloud, managed Chromium, Playwright, Puppeteer, Node browser scripts, `open`, `osascript`, AppleScript, or hardcoded CDP ports unless the user explicitly asks.

For browser tasks, do not reach for Playwright/Puppeteer scripts. The default path is a small Python harness script under `~/.pi/agent/browser-harness/` run with `chrome-harness < script.py`.

`chrome-harness` launches headless Chrome with `--headless=new`, `--remote-debugging-port=0`, `--remote-debugging-address=127.0.0.1`, and `--user-data-dir="$HOME/.pi/agent/chrome-profiles/headless-default"` when normal Chrome is not already running with live CDP. It then sets `BU_CDP_WS` and execs `browser-harness`.

Do not open or automate Chrome with AppleScript, `open location`, `open -a "Google Chrome" <url>`, `chromium.launch`, or `connectOverCDP` hardcoded to port 9222. Those bypass the harness/profile rules.

Chrome may choose a different remote-debugging port each time. Use the wrapper `chrome-harness`, not bare `browser-harness`, for normal local browser work. `chrome-harness` starts headless if needed, reads `DevToolsActivePort`, sets the correct `BU_CDP_WS`, and then execs `browser-harness`:

```bash
chrome-harness
```

If the user explicitly needs visible Chrome and Chrome is not running, open the normal app only:

```bash
open -a "Google Chrome"
```

Do **not** use `open -a "Google Chrome" <url>` as a fallback for browser tasks. That bypasses browser-harness and falsely reports success. Opening Chrome itself or the debug settings page is OK; opening the target URL must happen through `browser-harness` after remote debugging is enabled.

Default headless automation uses the separate automation profile so normal Dock Chrome remains usable. Do not use the user's default Chrome profile for headless unless user explicitly asks and accepts normal Chrome being blocked while headless is running.

Prefer reusable script files over inline programs. Keep local browser automation scripts under:

`~/.pi/agent/browser-harness/`

For anything beyond a tiny one-off, create or update a small script there, then run it through `chrome-harness`:

```bash
chrome-harness < ~/.pi/agent/browser-harness/open_page.py
```

Inline heredocs are OK for quick throwaway checks. Older fish-shell workarounds using `printf '%s\n' ... | chrome-harness` are no longer needed in Pi. Use `printf` only when a one-liner is genuinely clearer.

If `chrome-harness` cannot launch/connect after trying headless, inspect `~/.pi/agent/chrome-harness/logs/chrome.err` and report the error. If Chrome is already running but visible Chrome cannot connect, STOP and ask the user to enable `chrome://inspect/#remote-debugging` for the default profile, or quit Chrome so `chrome-harness` can launch headless with the same profile. On Chrome 144+ also ask the user to click **Allow** on the in-browser remote-debugging popup if it appears. Do not fall back to Helium, cloud, or `open -a "Google Chrome" <target-url>`.

Correct failure response for a default headless task when browser-harness cannot connect:

```text
I couldn't connect through chrome-harness/browser-harness. Chrome stderr is in ~/.pi/agent/chrome-harness/logs/chrome.err. If Chrome is already running, enable chrome://inspect/#remote-debugging or quit Chrome so chrome-harness can launch headless with the same profile.
```

Correct failure response for an explicit visible/current Chrome session task when `chrome-harness` cannot connect: ask the user to open normal Google Chrome, enable `chrome://inspect/#remote-debugging` for the profile they want, and click Allow on any remote-debugging popup.

Do not claim the target page was opened unless the `chrome-harness`/`browser-harness` command succeeded and `page_info()` verifies it.

Domain skills (community-contributed per-site playbooks under `agent-workspace/domain-skills/`) are off by default. Set `BH_DOMAIN_SKILLS=1` to enable them; see the bottom section.

**If `BH_DOMAIN_SKILLS=1` and the task is site-specific, read every file in the matching `agent-workspace/domain-skills/<site>/` directory before inventing an approach.**

## Usage

```bash
mkdir -p ~/.pi/agent/browser-harness
# create/update ~/.pi/agent/browser-harness/open_page.py with write/patch
chrome-harness < ~/.pi/agent/browser-harness/open_page.py
```

Example script:

```python
new_tab("https://docs.browser-use.com")
wait_for_load()
print(page_info())
```

- Invoke as `chrome-harness` for normal local browser work — it's on $PATH. No cd, no uv run.
- Prefer reusable scripts in `~/.pi/agent/browser-harness/`; update them as useful patterns emerge across sessions.
- Inline heredocs are OK for tiny one-offs, but do not grow long browser programs in chat.
- Do not create Playwright/Puppeteer/Node browser scripts unless the user explicitly asks for those tools.
- First navigation is new_tab(url), not goto_url(url) — goto runs in the user's active tab and clobbers their work.
- Prefer the documented helper names. Browser-harness is not Playwright: use `click_at_xy(...)` rather than `click(...)`, `js(...)` rather than `evaluate(...)`, and `type_text(...)` rather than `type(...)`/`hotkey(...)` patterns unless a helper is explicitly documented below or in interaction-skills.

## Tool call shape

```bash
chrome-harness < ~/.pi/agent/browser-harness/current.py
```

Scripts are plain Python snippets executed on stdin. Helpers are pre-imported; use `new_tab(...)`, `wait_for_load()`, `page_info()`, `js(...)`, `capture_screenshot(...)`, `click_at_xy(...)`, and `type_text(...)`. Do not import `BrowserHarness`, create a `browser`/`page` object, call `browser.new_page()`/`page.title()`, or call `chrome-harness file.py`. Always run saved scripts as `chrome-harness < file.py`. run.py calls ensure_daemon() before exec — you never start/stop manually unless you want to. If a program grows beyond a few lines, save it to the workspace and run `chrome-harness < file.py`; use tiny shell wrappers there only when setup/env repeats.

### Remote browsers

Use remote for parallel sub-agents (each gets its own isolated browser via a distinct BU_NAME) or on a headless server. BROWSER_USE_API_KEY must be set. start_remote_daemon, list_cloud_profiles, list_local_profiles, sync_local_profile are pre-imported.

```bash
browser-harness <<'PY'
start_remote_daemon("work")                               # default — clean browser, no profile
# start_remote_daemon("work", profileName="my-work")      # reuse a cloud profile (already logged in)
# start_remote_daemon("work", profileId="<uuid>")         # same, but by UUID
# start_remote_daemon("work", proxyCountryCode="de", timeout=120)   # DE proxy, 2-hour timeout
# start_remote_daemon("work", proxyCountryCode=None)      # disable the Browser Use proxy
PY

BU_NAME=work browser-harness <<'PY'
new_tab("https://example.com")
print(page_info())
PY
```

start_remote_daemon prints liveUrl and auto-opens it in the local browser (if a GUI is detected) so the user can watch along. Headless servers print only — share the URL with the user. The daemon PATCHes the cloud browser to stop on shutdown, which persists profile state. Running remote daemons bill until timeout.

Profiles (cookies-only login state) live in interaction-skills/profile-sync.md — covers list_cloud_profiles(), the chat-driven "which profile?" pattern, and sync_local_profile() for uploading a local Chrome profile.

## Interaction skills

If you start struggling with a specific mechanic while navigating, look in interaction-skills/ for helpers. They cover reusable UI mechanics like dialogs, tabs, dropdowns, iframes, and uploads. The available interaction skills are:
- connection.md
- cookies.md
- cross-origin-iframes.md
- dialogs.md
- downloads.md
- drag-and-drop.md
- dropdowns.md
- iframes.md
- network-requests.md
- print-as-pdf.md
- profile-sync.md
- screenshots.md
- scrolling.md
- shadow-dom.md
- tabs.md
- uploads.md
- viewport.md

## What actually works

- Screenshots first: use capture_screenshot() to understand the current page quickly, find visible targets, and decide whether you need a click, a selector, or more navigation.
- Clicking: capture_screenshot() → read the pixel off the image → click_at_xy(x, y) → capture_screenshot() to verify. Suppress the Playwright-habit reflex of "locate first, then click" — no getBoundingClientRect, no selector hunt. Drop to DOM only when the target has no visible geometry (hidden input, 0×0 node). Hit-testing happens in Chrome's browser process, so clicks go through iframes / shadow DOM / cross-origin without extra work.
- Bulk HTTP: http_get(url) + ThreadPoolExecutor. No browser for static pages (249 Netflix pages in 2.8s).
- After goto: wait_for_load().
- Wrong/stale tab: ensure_real_tab(). Use it when the current tab is stale or internal; the daemon also auto-recovers from stale sessions on the next call.
- Wrong command shape: if a helper name errors with `NameError`, check this skill or interaction-skills before inventing Playwright-style names.
- Verification: print(page_info()) is the simplest "is this alive?" check, but screenshots are the default way to verify whether a visible action actually worked.
- DOM reads: use js(...) for inspection and extraction when the screenshot shows that coordinates are the wrong tool.
- Iframe sites (Azure blades, Salesforce): click_at_xy(x, y) passes through; only drop to iframe DOM work when coordinate clicks are the wrong tool.
- Auth wall: redirected to login → stop and ask the user. Don't type credentials from screenshots.
- Raw CDP for anything helpers don't cover: cdp("Domain.method", params).

## Design constraints

- Coordinate clicks default. Input.dispatchMouseEvent goes through iframes/shadow/cross-origin at the compositor level.
- Connect to the user's running Chrome. Don't launch your own browser.
- cdp-use is only for CDPClient.send_raw. Prefer raw CDP strings over typed wrappers.
- run.py stays tiny. No argparse, subcommands, or extra control layer.
- Core helpers stay short. Put task-specific helper additions in `agent-workspace/agent_helpers.py`; daemon/bootstrap and remote session admin live in the core package.
- Don't add a manager layer. No retries framework, session manager, daemon supervisor, config system, or logging framework.

## Gotchas (field-tested)

- Omnibox popups are fake page targets. Filter chrome://omnibox-popup... and other internals when you need a real tab.
- CDP target order != Chrome's visible tab-strip order. Use UI automation when the user means "the first/second tab I can see"; Target.activateTarget only shows a known target.
- Default daemon sessions can go stale. ensure_real_tab() re-attaches to a real page.
- Browser Use API is camelCase on the wire. cdpUrl, proxyCountryCode, etc.
- Remote cdpUrl is HTTPS, not ws. Resolve the websocket URL via /json/version.
- Stop cloud browsers with PATCH /browsers/{id} + {"action":"stop"}.
- After every meaningful action, re-screenshot before assuming it worked. Use the image to verify changed state, open menus, navigation, visible errors, and whether the page is in the state you expected.
- Use screenshots to drive exploration. They are often the fastest way to find the next click target, notice hidden blockers, and decide if a selector is even worth writing.
- Prefer compositor-level actions over framework hacks. Try screenshots, coordinate clicks, and raw key input before adding DOM-specific workarounds.
- If you need framework-specific DOM tricks, check interaction-skills/ first. That is where dropdown, dialog, iframe, shadow DOM, and form-specific guidance belongs.

## Domain skills (opt-in)

Only applies when `BH_DOMAIN_SKILLS=1`. Otherwise ignore — `agent-workspace/domain-skills/` is dormant and `goto_url` won't surface skill files.

When enabled, search `agent-workspace/domain-skills/<host>/` before inventing an approach. `goto_url` returns up to 10 skill filenames for the navigated host.

If you learn anything non-obvious — a private API, stable selector, framework quirk, URL pattern, hidden wait, or site-specific trap — open a PR to `agent-workspace/domain-skills/<site>/`. Capture the durable shape of the site (the map, not the diary). Don't write pixel coordinates (break on layout), task narration, or secrets — the directory is public.
