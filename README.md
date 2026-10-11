# HandsFree — hands-free web browsing

Accessibility-focused browsing for people with motor impairments. Control a real browser with
**voice commands** and **webcam head tracking** — no mouse, no keyboard, no special hardware.

- **Voice navigation** — say "go to wikipedia", "search for alan turing", "scroll down", "go back".
- **Head & eye tracking** — look around to move the cursor smoothly in the controlled window.
- **Hands-free clicking** — click with a thumb-and-finger pinch.
- **Webcam eye tracking** — move your eyes to aim, pinch to click.
- **Speech to text** — live transcripts stream into the page (Chrome/Edge Web Speech API).
- **Safe selection** — risky actions (buy, submit, delete, send) always require a spoken
  *"confirm"*, and clicks on such buttons are refused outright.
- **Runs entirely offline** — the decision model is embedded in the Node process. No API key,
  no cloud, no LM Studio.

## Quick start

```powershell
# Windows
.\run.ps1
```

```bash
# macOS / Linux
node src/server.js
```

Then open **http://localhost:8787** in Chrome or Edge.

### As a Chrome/Edge extension

The extension is optional — the control page works on its own. Use it when you want voice and
tracking to run in the page you are actually browsing, rather than in a second control window.

1. Run `npm run build:extension` (generates `extension/head-tracker-core.js` from the shared tracker).
2. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and pick `extension/`.
3. Start the server, then click the HandsFree toolbar icon.

The service worker owns one WebSocket to `ws://127.0.0.1:8787` and reconnects with backoff.
MediaPipe and the landmark models are **vendored into `extension/vendor/`** (~30 MB), so the
extension works offline and satisfies the MV3 rule against remote code.

| keyboard | does |
| --- | --- |
| `Alt+Shift+H` | open the popup |
| `Alt+Shift+V` | start or stop voice control |

First run only: place the decision model at `models/Jev-Style-0.8B-Decision-v3-Q4_K_M.gguf`
([download](https://huggingface.co/chaoliangUNSW/Jev-Style-0.8B-Decision-v3-GGUF)). HandsFree also
finds it automatically in `~/.lmstudio/models`, or you can set `HANDSFREE_MODEL` to any `.gguf`.

Check your setup at any time:

```bash
npm run doctor
```

### Using the TypeSafe API instead

HandsFree is offline-first, but if you have a key you can use the hosted model instead:

```bash
TYPESAFE_API_KEY=your_key node src/server.js     # or set HANDSFREE_BACKEND=api
```

`HANDSFREE_BACKEND=auto` (the default) uses the key when present and the local model otherwise.

## Using it

Two windows appear:

| window | what it is |
| --- | --- |
| **control page** (`localhost:8787`) | mic button, head-tracking panel, probability bars, log |
| **controlled window** | the browser that actually acts |

Type a command into the control page if you have no microphone — same code path as speech.

### Eye tracking

Click **Enable eye control** and allow the camera. Move your **eyes** to move the cursor in the
controlled window. Press **Re-center** whenever you shift posture or want to change your neutral gaze.

**Clicking** is performed using a quick pinch gesture: bring thumb and index finger together, like a mouse click. One pinch = one click.

The cursor turns red and the status reads **pinch — click!** while a pinch is closed. Closing and
re-opening the pinch fires a new click, so you can click repeatedly by pinching again.

| control | what it does |
| --- | --- |
| **Tracking** `eyes` | natural gaze (eyes + head orientation) — most precise |
| **Tracking** `eyes + head` | averages gaze and head pose — steadier, recommended if you cannot hold still |
| **Tracking** `head only` | coarse; for people who cannot move their eyes comfortably |
| **Sensitivity** | gain. Turn up if the cursor will not reach the screen edges, down if it is too twitchy |
| **mirror** | flip left/right — turn off if the cursor moves the wrong way |
| **show video** | camera preview with the tracked points drawn on it |

How to aim: look at where you want the cursor, not at your screen. The cursor is the small amber
dot in the controlled window. It survives page loads and reappears in the same place.

Pinch detection normalises the thumb-to-finger distance by your hand size, so it works the same
whether you are close to or far from the camera, and it has a release threshold so a slightly
trembling hand cannot fire repeated clicks.

Eyes are used instead of the head because the head is far too coarse to reach the screen corners
without turning your whole body, and holding a fixed neck position for a second is uncomfortable.
If the camera cannot see your eyes clearly, switch to **eyes + head**.

Everything else keeps working if there is no camera or permission is denied — tracking is optional.

The tracker uses MediaPipe Face Landmarker in the browser; no video leaves the machine.

### Safety

- Destructive clicks are blocked and answered with *"say confirm to activate this"*.
- Every voice command still passes through the same policy gates as before: it must be addressed to
  the browser, confident, complete, and non-destructive.

## What you can say

| say | what happens |
| --- | --- |
| "go to wikipedia" / "open youtube" / "open claude" | navigates (site list, spoken domain, or known URL) |
| "open shorts" / "open subscriptions" / "open my history" | goes to that page inside YouTube |
| "search for alan turing" | uses the page's search box, else DuckDuckGo |
| "search youtube for lofi beats" | site-specific search |
| "click the first result" / "click the second link" | clicks the element the model picks, or shows numbered overlays |
| "type hello world into the search box" | types verbatim |
| "scroll down a bit" / "scroll to the bottom" | scrolls |
| "go back" / "go forward" / "reload" | history |
| "open a new tab" / "close this tab" / "next tab" | tabs |
| "click place order" | refused — say **"confirm"** |
| "so anyway I think we should get lunch" | ignored |

Common commands are recognised by a rule-based fast path in microseconds. Anything the rules do not
recognise goes to the decision model, which reads intent, target, site and completeness in a single
pass and returns calibrated probabilities.

## Architecture

```
 microphone (Web Speech API)          Node server                       controlled window
 ───────────────────────────   ws    ──────────────────────────         ──────────────────
 partial transcripts ───────────────▶ debounce, cancel stale            Playwright Chromium
 "open wikip…"                      page snapshot (≤100 elements) ◀──   persistent profile
                                    ONE model pass:                     highlight / toast /
 "Open Wikipedia."  ◀────────────────  intent · target · site ·          numbered overlays
                                    complete · is_command · …           pinch-to-click
```

- `src/runtime.js` loads the GGUF in-process via `node-llama-cpp` (GPU, CPU fallback).
- `src/decision.js` maps the typed questions onto a single `decide()` call — one forward pass reads
  every verdict slot and returns real probabilities.
- `src/rules.js` recognises everyday commands instantly, with no model call.
- `src/policy.js` turns answers into act / wait / ignore / confirm / disambiguate, with every
  threshold shown live in the UI.
- `src/public/head-tracker.js` runs webcam eye/head tracking and pinch-to-click. The extension
  reuses it via `scripts/build-extension.js`, so both surfaces track identically.

## Configuration

| variable | default | meaning |
| --- | --- | --- |
| `HANDSFREE_BACKEND` | `auto` | `auto` · `local` · `api` |
| `TYPESAFE_API_KEY` | — | use the hosted API when set |
| `HANDSFREE_MODEL` | auto-discovered | path to the decision-model `.gguf` |
| `HANDSFREE_GPU` | `true` | GPU, falling back to CPU automatically |
| `HANDSFREE_CONTEXT` | `4096` | model context size |
| `PORT` | `8787` | control page port |

Options: `node src/server.js --port 9000 --headless --start-url https://…`,
or attach to a browser you already started with `--cdp http://127.0.0.1:9222`.

## Tests

```bash
npm test              # unit tests
npm run test:all      # unit + integration
npm run build:extension
```

`npm test` needs no model and no network. The integration suite asserts on real model
probabilities, so it skips unless a decision model is present or `TYPESAFE_API_KEY` is set.

## Security

The server listens on `127.0.0.1` only. Anyone who can reach the port can drive the browser, so do
not use `--host 0.0.0.0` on a network you do not trust. The controlled browser uses a persistent
profile in `.browser-profile/` — do not log into accounts there that you would not want a mis-heard
command to touch.

## License

MIT. The bundled decision model is Apache-2.0 (Jev-Style, an independent project not affiliated
with TypeSafe AI). MediaPipe models are Apache-2.0.