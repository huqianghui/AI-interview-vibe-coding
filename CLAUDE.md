# gstack

For all web browsing, use the `/browse` skill from gstack. Never use `mcp__claude-in-chrome__*` tools.

Available gstack skills:
- `/office-hours`
- `/plan-ceo-review`
- `/plan-eng-review`
- `/plan-design-review`
- `/design-consultation`
- `/design-shotgun`
- `/design-html`
- `/review`
- `/ship`
- `/land-and-deploy`
- `/canary`
- `/benchmark`
- `/browse`
- `/connect-chrome`
- `/qa`
- `/qa-only`
- `/design-review`
- `/setup-browser-cookies`
- `/setup-deploy`
- `/setup-gbrain`
- `/retro`
- `/investigate`
- `/document-release`
- `/document-generate`
- `/codex`
- `/cso`
- `/autoplan`
- `/plan-devex-review`
- `/devex-review`
- `/careful`
- `/freeze`
- `/guard`
- `/unfreeze`
- `/gstack-upgrade`
- `/learn`

## gstack (REQUIRED — project-level install)

gstack is vendored in this project at `.claude/skills/gstack/` (NOT globally).

**Before doing ANY work, verify gstack is installed:**

```bash
test -d .claude/skills/gstack/bin && echo "GSTACK_OK" || echo "GSTACK_MISSING"
```

If GSTACK_MISSING: STOP. Do not proceed. Tell the user:

> gstack is required for all AI-assisted work in this repo.
> Install it (project-level):
> ```bash
> git clone --depth 1 https://github.com/garrytan/gstack.git .claude/skills/gstack
> cd .claude/skills/gstack && ./setup
> ```
> Then restart your AI coding tool.

Do not skip skills, ignore gstack errors, or work around missing gstack.

Using gstack skills: skills like /qa, /ship, /review, /investigate,
and /browse are available. Use /browse for all web browsing.
Use .claude/skills/gstack/... for gstack file paths (the project-level path,
relative to the repo root). Do NOT use ~/.claude/skills/gstack — it no longer exists.

## Planning documents live in the repo, not ~/.gstack

gstack writes planning artifacts (from `/spec`, `/office-hours`, `/plan-*`, `/autoplan`) to the
local, per-developer, machine-only path `~/.gstack/projects/<slug>/`. Those are NOT discoverable
by teammates and do NOT travel with the repo. For THIS project, planning documents are
project-relevant deliverables the owner reviews — they must live in the repo under `docs/`.

**Rule:** whenever a gstack skill produces a project-relevant planning document (a spec, design/
brainstorm doc, plan, or review), promote a copy into the repo and commit it:

- Specs / design / brainstorm / plan / review docs → `docs/planning/` (keep
  `docs/planning/README.md`'s spec-lineage list current when you add one).
- The authoritative living spec stays at the repo root: `SPEC.md`.
- Keep `docs/IMPLEMENTATION-STATUS.md` current: map each feature to its shipped version + any
  live-Azure validation state when you ship.

Do NOT copy machine-local working state into the repo: review logs (`*-reviews.jsonl`), session
`timeline.jsonl`, `brain-cache/`, `.DS_Store`. Those stay in `~/.gstack/` by design.

The gstack project artifact dir for reference (source to promote FROM, never the home for
project docs): `~/.gstack/projects/<slug>/` (this project's slug is
`huqianghui-AI-interview-vibe-coding`).
