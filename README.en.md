<div align="center">

<img src="public/icons/icon-128.png" width="96" alt="Chrome Form Assistant" />

# Chrome Form Assistant

**AI form filler: complete any form in one sentence. Bring Your Own Key.**

[![Release](https://img.shields.io/github/v/release/your-org/chrome-assistant?style=flat-square)](../../releases)
[![License](https://img.shields.io/github/license/your-org/chrome-assistant?style=flat-square)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-0D9488?style=flat-square)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![BYOK](https://img.shields.io/badge/LLM-BYOK%20OpenAI--Compatible-0D9488?style=flat-square)](#-configure-llm)

[中文](README.md) · English

</div>

> A Chrome MV3 extension. Open the side panel on any page → it scans the form fields → describe what to fill in plain English → an OpenAI-compatible LLM proposes a value for each field → preview, tweak, and one-click fill. **Bring Your Own Key.**

---

## Demo

<div align="center">

<img src="docs/demo.gif" alt="Full flow demo" width="720" />

<sub>📽️ <em>Full demo GIF coming soon</em> — see <a href="docs/README.md">docs/README.md</a> for recording tips</sub>

</div>

---

## ✨ Features

- 🎯 **Selector-free** — Numeric element-id mapping. Robust against dynamic class names (Tailwind / CSS-in-JS / MUI).
- 🪄 **AI reads the page** — One click and the LLM drafts an intent template from the field labels; or describe it yourself.
- 🔒 **BYOK & local-first** — Any OpenAI-compatible endpoint. Settings live only in `chrome.storage.local`.
- ✅ **Preview & confirm** — Edit or skip individual fields before they hit the page. No surprises.
- 🧩 **React-friendly** — Writes via native setter + dispatched events to bypass controlled-component state overrides.
- 📜 **Observable** — Built-in log viewer (LLM prompt/response included). Optional NDJSON-on-disk via the File System Access API.

---

## 🚀 Quick Start

### 1. Install

**Option A: download a Release (recommended)**

1. Grab the latest `chrome-assistant-vX.Y.Z.zip` from [Releases](../../releases) and unzip it
2. Open `chrome://extensions/` and enable **Developer mode** (top right)
3. Click **Load unpacked** and select the unzipped folder

**Option B: build from source**

```bash
pnpm install
pnpm gen:icons    # renders extension icons via ImageMagick (macOS: brew install imagemagick)
pnpm build        # output → dist/
```

Then load `dist/` the same way as Option A.

### 2. Configure LLM

Click the toolbar icon → top-right ⚙ in the side panel:

| Field | Default | Notes |
|---|---|---|
| Endpoint | `http://localhost:3000/api/v1/llm` | Just the `/llm` base — the extension appends `/chat/completions` automatically |
| API Key | `not-needed` | Use `not-needed` for local proxies that don't validate; otherwise paste your key |
| Model | `gemini-3.1-pro` | Any OpenAI-compatible model name |
| Temperature | `0.3` | Form filling prefers determinism; 0 ~ 0.5 works well |

Click **Test connection** — a green check means you're good.

### 3. Use

1. Navigate to a page with a form (sign-up, survey, profile, etc.)
2. Click the toolbar icon → side panel opens
3. Click **Scan current page** — the extension extracts fillable fields
4. Pick one of two ways to describe your intent:
   - 🪄 **Let AI read the page** — the LLM reads the field labels and a page summary, then drafts a sensible intent template you can tweak
   - ✍️ Or type it yourself, e.g. *"Sign me up: name John Doe, email a@b.com, subscribe to the newsletter."*
5. Click **Generate fill plan** — the LLM proposes a value per field
6. Review in the preview panel: toggle, edit, or skip rows
7. Click **Confirm fill (N fields)** — affected inputs flash green when written

---

## 📋 Known Limits (MVP Non-Goals)

| Not supported | Why |
|---|---|
| Closed Shadow DOM | Browser security boundary |
| Cross-origin iframes | Same-origin policy |
| Rich-text editors (Quill / CKEditor / TinyMCE) | Private APIs, not portable |
| File-upload inputs | Security: extensions cannot synthesize `<input type=file>` values |
| Multi-step / paginated forms | Out of MVP scope; would need a multi-turn agent loop |
| CAPTCHAs | Not bypassable |

When a field can't be filled, the extension surfaces an explicit "unsupported" status — no silent failures.

---

## 🛠️ Development

```bash
pnpm install
pnpm dev          # HMR mode (keeps dist hot-reloading)
pnpm build        # production build
pnpm typecheck    # tsc --noEmit
pnpm gen:icons    # regenerate extension icons (needs ImageMagick)
pnpm verify       # CDP end-to-end checks (needs Chrome started with --remote-debugging-port=9222)
```

### End-to-end verification (CDP-driven)

Requires Chrome launched with `--remote-debugging-port=9222` and the extension loaded from `dist/`.

```bash
pnpm build && pnpm verify
```

This opens a test tab, triggers `EXTRACT_FIELDS` / `FILL_FIELDS` via the service worker, asserts the DOM, then queries the log system. Exit code `0` = pass.

---

## 🏗️ Project Structure

```
src/
├── shared/
│   ├── messages.ts         # cross-context message types + field/fill instruction models
│   ├── settings.ts         # chrome.storage helpers
│   ├── logger.ts           # unified logger (FSA writer + ring buffer)
│   └── ui.tsx              # shared UI atoms (Button/Icon/Input/...)
├── background/
│   ├── index.ts            # service worker entry (message router)
│   └── llm.ts              # LLM client (fetch + JSON mode + error tolerance)
├── content/
│   ├── index.ts            # content script entry
│   ├── extractor.ts        # field extraction + ELEMENT_REGISTRY
│   └── filler.ts           # native-setter writer + flash highlight
├── sidepanel/              # side panel UI (main flow)
├── options/                # settings page + log directory management
└── logs/                   # full log viewer page

public/icons/               # extension icons (svg source + 4 PNG sizes)
.github/workflows/          # CI: auto-release on every push
docs/                       # demo assets referenced from README
```

---

## 🤖 Key Architectural Decisions

1. **Numeric element-id mapping** — the content script assigns each interactive element a numeric id; the LLM emits `{id, value}` JSON; we look up the element on fill. Far more reliable than asking the LLM to emit CSS/XPath selectors.
2. **Native `chrome.sidePanel`** — no injected floating UI, avoids z-index / CSP / style isolation issues entirely.
3. **Native setter + dispatched events** — values are written via `Object.getOwnPropertyDescriptor(...).set.call(el, v)` followed by `input`/`change` events, so React (and other framework) controlled inputs accept them.
4. **BYOK + single-turn** — no user profile storage, no multi-turn memory; settings live in `chrome.storage.local` only.

---

## 📦 Releases & Automation

Every push to `master` triggers CI to:

1. Read the latest `v*` tag and bump the patch version
2. Sync the version to `package.json` (`manifest.config.ts` reads `pkg.version`, so the manifest follows automatically)
3. Run `pnpm install && pnpm gen:icons && pnpm build`
4. Zip `dist/` as `chrome-assistant-vX.Y.Z.zip`
5. Create a GitHub Release with auto-generated release notes

See [`.github/workflows/release.yml`](.github/workflows/release.yml).

---

## 📜 License

MIT
