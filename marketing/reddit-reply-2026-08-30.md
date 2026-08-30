# Draft reply — Reddit feedback, 2026-08-30

Plan for the underlying work: **BACKLOG.md → "Round 3 — Reddit feedback"** (items R1–R10).

Context: R1 (no debounce on the LP), R2 (issue #3, uncapped simplex) and R3 (synchronous save
parses) are all confirmed causes of the freeze. Projects + cross-plan links already ship.
The multiplier complaint is ambiguous, so the reply asks one specific question rather than
guessing — but R5 (Base X-ray ignoring the Recipe Parts Cost Multiplier) is a confirmed silent
bug and is owned in the reply regardless.

---

## Reply (post as-is)

Thank you — and this is a genuinely useful comment, all three parts. Taking them in order:

**The freezing.** You found a real bug, and I can reproduce it. Every keystroke in the input and
output fields re-solves the whole factory, synchronously, on the same thread that draws the UI —
so typing an item name means one full solve per character. On a plan with a few outputs that's
half a second per character on the default objective, and up to ~2 seconds each on "Fewest loops"
or "Fewest connections." The window is dead for that whole stretch and your keystrokes queue up,
which is exactly what you're seeing: it won't take input, then you wait, then everything you typed
lands at once. Fixing it is a debounce — solve once you stop typing instead of on every character —
and it's now top of my list. Two smaller things pile onto the same freeze: the LP library can spin
for 100k+ iterations on plans with lots of alternates plus recycle loops (someone filed that
separately, with a patch), and if you have the map or Base X-ray loaded, the app re-parses your
save on the game's autosave — also on the UI thread. All three are on the list. Sorry about that
one; it should never have shipped feeling like that.

**One Project or one Factory — and can outputs feed another factory's input?** Yes to both, and
this already works today, it's just not advertised well enough:

- A **Project** holds any number of factory plans. The plan bar at the top is the plans inside the
  current project; the dropdown above it switches projects. Use one project per megabase and one
  plan per physical factory.
- To feed one into another: in the consuming plan (Recipe Optimizer or Max Throughput), under
  **Allowed input resources**, hit **+ add intermediate input**, then use the dropdown on that row
  to pick `<other plan> → <item>`. That input's rate then tracks the source plan's output
  automatically — change the upstream factory and the downstream one re-solves. Cycles are blocked,
  and chains propagate the whole way down (A→B→C).
- **Project Totals** then rolls the whole project up — combined power, machines and raw draw, with
  anything one plan supplies to another netted out so it isn't double-counted as raw.

One gap worth knowing: that link control lives on Optimizer and Max Throughput rows only, not on
the older Planner tab. If you're working in the Planner, that's why you haven't seen it. Making it
visible from the Project view is on the list too — your question is the evidence that it's hidden.

**The production multiplier** — can I ask which one you mean, so I fix the right thing? There are a
few and they behave differently:

- the **Recipe Parts Cost Multiplier / Power / Space Elevator** dropdowns (⚙ Settings → Cost
  Multiplier), which mirror Advanced Game Settings;
- **Overclock**, per step or global;
- **Somersloops** (the game calls it production amplification), set per step in the production
  table or by clicking a machine on the flowchart.

Which one, and which tab were you on? Meanwhile, digging into this I did find a real one: **Base
X-ray ignores the Recipe Parts Cost Multiplier entirely.** Every other mode applies it to
ingredient costs; the X-ray doesn't, so if you run a non-1× cost multiplier, the whole-base
consumption numbers it reports are wrong — silently. That's fixed next. Two more found on the way:
Max Throughput quietly ignores overclock and Somersloops rather than saying so, and the recipe
dropdown still prints the un-multiplied ingredient amounts even when the multiplier is applied to
the actual maths.

One other thing worth checking on your end: the multipliers **aren't** read from your save — the
app reads your save for unlocked alternates, but the cost multipliers you have to set by hand in
⚙ Settings. If you have them at non-default values in-game and left the app at 1×, that alone would
make every number look wrong. Auto-detecting them from the save is on the list; until then it's
worth a look.

Really appreciate you taking the time to write all that up — this is the useful kind of feedback.

---

## Notes for follow-up (not part of the reply)

- If they answer with a specific multiplier + tab, check it against R5–R9 before assuming a new bug.
- If they say **Base X-ray**, R5 is a direct hit — say so and ship it.
- If they say **Somersloop**, that's R9; the fix is threading `sloopMult` into `maxThroughput`, or
  labelling the limitation.
- Offer them the build once R1 ships — they're an engaged tester and the freeze is the thing they'll
  notice first.
