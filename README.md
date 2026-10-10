# HandsFree — hands-free web browsing

Accessibility-focused browsing for people with motor impairments. Control a real browser with
**voice commands** and **webcam head tracking** — no mouse, no keyboard, no special hardware.

- **Voice navigation** — say "go to wikipedia", "search for alan turing", "scroll down", "go back".
- **Head & eye tracking** — look around to move the cursor smoothly in the controlled window.
- **Hands-free clicking** — click with a thumb-and-finger pinch, or point and say a number.
- **"Show numbers"** — badge everything clickable, then say "click 14". No guessing involved.
- **Dictation** — click into a field and just talk; it types where the caret is.
- **Scrolling that follows your eyes** — look at a chat pane and say "scroll down"; it scrolls
  that pane, not the page.
- **Speech to text** — live transcripts stream into the page (Chrome/Edge Web Speech API).
- **Spoken replies** — prompts and confirmations are spoken, not only shown.
- **Safe selection** — risky actions (buy, submit, delete, send) always require a spoken
  *"confirm"*, whichever way they were aimed.
- **Runs entirely offline** — the decision model is embedded in the Node process. No API key,
  no cloud, no LM Studio.

> **One caveat on "offline":** the *decision model* is local, but the microphone uses the browser's
> Web Speech API, which in Chrome and Edge sends your audio to Google's speech service. Everything
> else — screenshots, page contents, the model — stays on the machine. Using a local recognizer is
> the one part not yet built.

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

Two things on the control page are worth turning on:

- **Snap to elements** (on by default) — the cursor is drawn onto whatever clickable thing it is
  near, so aiming is forgiving. It is also what makes scrolling follow your eyes.
- **Speak replies** — confirmations and errors are read aloud as well as shown.

If you would rather not be heard at all, say **"stop listening"**.

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

## What you can say

### Pointing at things — the most reliable way to click

Picking an element by name puts the whole task on the model matching words to an element. Numbering
what is on screen removes that dependency entirely.

| say | what happens |
| --- | --- |
| "show numbers" | badges every link, button and field in visual order |
| "click 14" | clicks the numbered item — deterministic, no model call |
| "hide numbers" | clears the badges |

Numbers work to 60, as digits or words ("fourteen", "twenty three").

### Navigating and scrolling

| say | what happens |
| --- | --- |
| "go to wikipedia" / "open youtube" / "open claude" | navigates (site list, spoken domain, or known URL) |
| "open shorts" / "open subscriptions" / "open my history" | goes to that page inside YouTube |
| "search for alan turing" | uses the page's search box, else DuckDuckGo |
| "search youtube for lofi beats" | site-specific search |
| "go back" / "go forward" / "reload" | history |
| "open a new tab" / "close this tab" / "next tab" / "previous tab" | tabs |
| "go to tab 3" / "tab two" | jumps straight to that tab |
| "reopen closed tab" | brings back the last closed tab |
| "close the other tabs" | closes everything except this one |
| "find on page" | opens the browser's find bar |
| "zoom in" / "zoom out" / "reset zoom" | page zoom |
| "read this page" | reads the main content aloud |

Scrolling is aimed by **where the cursor is**, so look at what you want to move. A chat pane, modal
or feed scrolls instead of the page whenever it is under the cursor.

| say | what happens |
| --- | --- |
| "scroll down" / "scroll up" / "scroll a bit" | scrolls whatever is under the cursor |
| "scroll right" / "scroll left" | horizontal scrolling |
| "scroll to the bottom" / "go to the top" | jumps to the end of that container |
| "keep scrolling" | repeats until you say "stop scrolling" |

A bare "up", "down", "left" or "right" scrolls. To move the caret instead, name the arrow.

### Clicking

Put the flavour first. Hovering and right-clicking do not activate anything, so they are never
treated as risky; a double-click fires two click events and so still asks for confirmation.

| say | what happens |
| --- | --- |
| "click the first result" / "click sign in" | clicks the element the model picks, or shows numbered overlays |
| "right click on the file" | context menu |
| "double click the icon" | double-click |
| "hover over the menu" | moves the pointer only, clicks nothing |
| "open docs in a new tab" | opens the link in a new tab |
| "drag the file onto the bin" | drags to a named drop target |
| "drag it right" / "drag it down" | drags in a direction — this is how you move a slider |

### Typing and the keyboard

| say | what happens |
| --- | --- |
| "type hello world into the search box" | replaces the contents of the named field |
| "clear the box" | empties the focused field |
| "tab" | moves to the next field |
| "escape" / "dismiss that" | closes a dialog, menu or popup |
| "backspace" / "delete" | edits |
| "up arrow" / "press down" / "home" / "end" / "space" | caret movement (a bare "up" scrolls) |
| "select all" / "copy" / "paste" / "cut" | real browser chords |
| "control z" / "control y" | text undo and redo |

**Dictation.** Click into any text field — with the cursor, a pinch, or "click the email box" — and
from then on just **say the words**. They are typed where the caret is, and they **append** rather
than replacing what is there. Filling in a form then goes:

```
click the Full name field → "Alan Turing" → "tab" → "alan@example.com" → "tab"
```

Dictation is off until you click a field, and it stops at anything that navigates away. A real
command always wins over being typed into a box, so "show numbers" never types itself.

### The microphone and spoken replies

| say | what happens |
| --- | --- |
| "stop listening" / "pause listening" | mutes the microphone |
| "start listening" / "wake up" | unmutes it |

Prompts, pending confirmations and failures are **spoken as well as shown**, since a toast is no
use to someone who cannot see the screen. Turn that off with the *Speak replies* checkbox.

### Safety

| say | what happens |
| --- | --- |
| "click place order" | refused — waits for **"confirm"** |
| "confirm" / "cancel" | resolves or drops the pending action |
| "again" / "repeat that" | repeats the last action |
| "so anyway I think we should get lunch" | ignored |

A spoken click on anything whose label reads like a risk (place order, checkout, buy now, delete,
send message, subscribe, sign in) requires a confirmation, whichever way it was aimed — by name, by
number, or by cursor. Pinch clicks are guarded the same way.

"Again" replays only the single previous action, and never a destructive one.

### Dialogs, downloads and file pickers

A JavaScript `alert`, `confirm` or `prompt` is held rather than dismissed behind your back, read
out to you, and answered with **"yes"** or **"no"** — the same words you already use to confirm and
cancel. Downloads are announced by filename.

Choosing a file is **not** supported: a file picker is cancelled and you are told why, rather than
being left with a frozen tab. Opening a file by voice needs a real file picker and is the obvious
next piece of work.

### Macros

Some journeys are the same every day. Put them in `macros.json` next to `package.json` and trigger
the whole thing with one phrase:

```json
{
  "timesheet": ["go to example dot com", "show numbers", "click 3", "search for this month", "press enter"]
}
```

Then say **"do my timesheet"** (or "run the timesheet", "start timesheet macro").

Each step is an ordinary command, run through the same rules, model and confirmation gate as
anything you say by hand — a macro cannot do anything you could not already do. It stops at the
first step that needs a confirmation or could not resolve its target, rather than ploughing on. A
missing or malformed `macros.json` is ignored with a message in the log, never fatal.

Common commands are recognised by a rule-based fast path in microseconds. Anything the rules do not
recognise goes to the decision model, which reads intent, target, site and completeness in a single
pass and returns calibrated probabilities.

## Performance Evaluation

The control page includes an **Evaluation** panel for comparing HandsFree with conventional
mouse-and-keyboard input on repeatable tasks. Pick a task, choose the input method, press **Start**,
perform the task, then press **Finish pass** or **Finish fail**. Results are stored locally in
`.handsfree-evaluation.json`, which is ignored by git.

Automatically measured:

- Task completion time, from **Start** to **Finish**.
- Command/action attempts observed during the run.
- Execution success rate from actions that the browser reports as succeeded or failed.
- Pointer click activations from head/hand tracking messages.

Manual markings:

- Command accuracy: press **Command ok** or **Command wrong** while reviewing a run.
- Selection errors: press **Selection error** when the wrong element was selected.
- Accidental activations: press **Accidental action** when an unintended click/action happened.
- Dictation accuracy: enter expected and actual dictated text; the UI calculates edit-distance
  similarity when both are present.

The dashboard does not claim improvements on its own. It only summarizes the data you record,
grouped by input method, so you can compare HandsFree runs with mouse-and-keyboard runs under the
same tasks.

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
- `src/public/head-tracker.js` runs webcam eye/head tracking and pinch-to-click in the control page.

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
npm test
```

## Security

The server listens on `127.0.0.1` only. Anyone who can reach the port can drive the browser, so do
not use `--host 0.0.0.0` on a network you do not trust. The controlled browser uses a persistent
profile in `.browser-profile/` — do not log into accounts there that you would not want a mis-heard
command to touch.

## License

MIT. The bundled decision model is Apache-2.0 (Jev-Style, an independent project not affiliated
with TypeSafe AI). MediaPipe models are Apache-2.0.
