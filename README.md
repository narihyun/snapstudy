# SnapStudy

An AI study agent for the language screenshots that pile up in your photo library.
Drop in many screenshots at once (or a whole folder). The agent:

1. **Sorts** them (TRIAGE): keeps screenshots with the language you study, sets the rest aside with a reason. You can override ("Study anyway" / "Set aside").
2. **Reads and recovers context** (LESSON): reads each kept screenshot, guesses why you saved it and where it came from, and picks at most four words, phrases or grammar points at your level.
3. **Checks its own work**: every item must be copied exactly from the screenshot, a fill-in-the-blank must rebuild the original sentence, answers may not leak into questions or hints. Failures go back to the AI once with the list of problems; what still fails is dropped. Every word always gets a recall question that cannot be guessed (meaning → type the word).
4. **Teaches, then checks** (Practice): a guided lesson goes *learn → meaning in context → recall → use it in your own sentence*. Wrong answers get hints (not the answer); written answers are checked by the AI, which names the problem and asks a guiding question.
5. **Brings it back** (Adapt + Today): only recall without help moves a review date forward (3, 7, 14, 30, 60 days); a mistake brings the word back tomorrow. A word saved again in another screenshot is moved up. The Practice page shows the agent's plan for today, including a forgotten screenshot and why you saved it.

You can also **choose text** yourself: drag boxes over parts of a screenshot (or let the browser find text boxes), mark a focus area, and list the words you want. The agent builds a new lesson from only those parts.

Design and practice flow are based on **Recollect** (Anna Surovkova): library, flashcards, recall, guided writing, mini-dialogue, hints, honest recaps and progress. SnapStudy adds drag-and-drop of many files and folders, the sorting agent with a "Set aside" list, context recovery, merged words across screenshots and the daily plan.

## No login

There is no account. Everything (settings, lessons, progress, images) is stored in the visitor's own browser. *Settings → Your data in this browser* has **Download backup** / **Load backup** to move it. Anyone can open the public URL and use it right away.

## Where the OpenAI key lives

Only on the server, never in the browser or in Git.

- **Netlify**: Site configuration → Environment variables → `OPENAI_API_KEY` (optional `OPENAI_MODEL`, default `gpt-4.1-mini`). Redeploy after adding it.
- **Your computer**: a file named `.env` next to `local-server.mjs` with `OPENAI_API_KEY=sk-...`. `.env` is in `.gitignore`.

The browser calls `/api/ai` with a step name and data only. All prompts are on the server (`netlify/prompts.mjs`), so the endpoint cannot be used as a free general chatbot. Set a monthly spending limit in your OpenAI account.

## Run locally

```sh
node local-server.mjs     # Node 18+, no packages needed
# open http://localhost:8888
```

## Files

| File | What it does |
| --- | --- |
| `netlify/prompts.mjs` | All prompts: triage, lesson, grade, today |
| `netlify/functions/ai.mjs` | Server relay to OpenAI (`/api/ai`), holds the key |
| `public/js/agent.js` | Agent loop: sort → lesson → check → revise once → merge → today plan |
| `public/js/practice.js` | Sessions, hints, grading, review dates, recap, word status |
| `public/js/regions.js` | Choosing parts of a screenshot (draw boxes / automatic text boxes) |
| `public/js/store.js` | Browser storage (localStorage + IndexedDB) |
| `public/js/app.js` | Screens: Library, Practice, Progress, dialogs |
| `public/samples/` | 23 sample screenshots for a quick demo |

"Demo: move time 3 days ahead" in Settings shows how reviews come due.
