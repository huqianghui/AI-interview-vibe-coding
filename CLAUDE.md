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
