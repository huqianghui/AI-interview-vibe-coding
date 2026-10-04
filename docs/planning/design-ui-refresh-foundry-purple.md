# UI refresh: "Warm Editorial / Foundry Purple" (approved design direction)

**Date:** 2026-10-03 · **Skill:** `/design-shotgun` · **Status:** direction approved **and
implemented** (see §5) · **Artifacts:** `~/.gstack/projects/huqianghui-AI-interview-vibe-coding/designs/ui-refresh-20261003/`

The owner's complaint was that the candidate-facing UI reads neither professional nor fashionable:
"这些页面都很窄，看着都集中在中间，颜色，色调等等都和不专业和fashion". This document records what was
actually wrong, the four directions explored, the owner's decisions, and the approved token set.

---

## 1. What was actually wrong (diagnosed against the live site, not guessed)

Half of it was not taste. It was layout defects.

| # | Defect | Where |
| --- | --- | --- |
| 1 | Non-live phases are locked to a **760px** column while the live phase uses **1400px** — one route, two content widths, and on a wide screen 760px fills 38% of it | `frontend/src/pages/InterviewPage.tsx:87` vs `:102/:181/:219` |
| 2 | **Two nested centred containers**: a 420px `LoginCard` inside the 760px page column, so the page title and the card do not share a left edge (visible as a ragged left margin on the sign-in screen) | `frontend/src/components/LoginCard.tsx:15` inside `InterviewPage.tsx:87` |
| 3 | `Restart` / `Sign out` sit in a bare `<div>` with **no gap and no vertical spacing**, at `size="small"` while everything else is default — reads as debug buttons that leaked out | `InterviewPage.tsx:1443-1448` |
| 4 | The orientation primary button is stretched **full width by accident** — Fluent `Card` is a flex column with `align-items: stretch` | `InterviewPage.tsx:1466` |
| 5 | The header is an **inline-styled flex with only a language dropdown**, `justify-content: flex-end` — no bar, no logo, no divider, so the control floats in a ~150px dead band | `frontend/src/App.tsx:12-20` |
| 6 | `webLightTheme` used bare: Fluent's default blue `#0F6CBD`, one font (Segoe UI), hierarchy from size only, zero depth, no visual anchor | `frontend/src/App.tsx:11` |
| 7 | **Chrome's autofill** repaints a prefilled field with its own `#E8F0FE` light blue, overriding every Fluent token. Two prefilled fields were enough to make the sign-in screen read like a Windows form | browser behaviour, not app code |

Items 1-5 are bugs. Item 6 is the design-language gap. Item 7 is a correction to this document's
first draft, which blamed the light-blue input fill on "Fluent's default filled inputs" — that was
wrong, and it changed the fix. Verified: Fluent `Input`'s default appearance IS `outline` and it
paints `colorNeutralBackground1`, which in `webLightTheme` is `#ffffff`. The blue was Chrome. So
the fix is a `:-webkit-autofill` override, not an appearance change; without it the new warm theme
would still be repainted light blue on exactly the screen the owner complained about.

## 2. Directions explored and why three were cut

Four hand-authored HTML mockups (not AI images — the gstack `design` binary hard-codes
`api.openai.com` + `gpt-image-2` and the only key available is an Azure OpenAI key, so that path
401s; hand-authored HTML also yields liftable CSS instead of a picture to re-implement).

| Direction | Verdict |
| --- | --- |
| **A — Studio Noir** (near-black, copper accent, Archivo Expanded, full-bleed stage) | Cut: owner rejected dark outright |
| **B — Clinical White** (paper ground, layered shadows, Instrument Serif, deep ink) | Kept to the palette round, then cut |
| **C — Terminal Precision** (charcoal, electric lime, JetBrains Mono, visible 12-col grid) | Cut: owner rejected dark outright |
| **D — Warm Editorial** (warm sand, terracotta/green, Bricolage Grotesque + Literata, asymmetric) | **Approved** |

Owner feedback that shaped the second round, verbatim: *"这种太黑的A和C肯定不行。B和D可以，我不喜欢
这种太简单一个头和一个身体的造型，如果需要的话，就使用数字人里面的照片"* — so the CSS head+shoulders
silhouette was replaced with the app's own official avatar photo
(`lisa-casual-sitting`, MS Learn CDN, the roster already in `frontend/src/data/avatarCharacters.ts:48`).

## 3. Palette round: Azure blue vs Foundry purple

The owner asked whether to use Azure's own brand colours. Both were built and compared
(`B-blue`, `B-purple`, `D-blue`, `D-purple`).

The risk stated up front: **Azure Blue `#0078D4` shares a hue with the Fluent default `#0F6CBD`
that makes the current UI read cheap**, so a naive hue swap lands back where it started. Blue was
therefore built using Azure's own three-colour structure (`#243A5E` authority, `#0078D4` action
only, `#50E6FF` small-area accent) rather than as a single flat brand colour.

**Decision: `D-purple`.** Purple is still inside the Microsoft family (all three values are Fluent
palette entries already present at `avatarCharacters.ts:58`), it reads as *Azure AI* (the Foundry /
Copilot brand register) rather than Azure-the-platform, and it is not the hue that currently reads
cheap — so it separates from the old look on sight.

## 4. Approved token set

```
ground   #F5F1EA   surface  #FFFDF9   inset    #EBE5DA
ink      #4A2680   ink-hi   #3A1D66          (authority + headings)
action   #5C2E91   action-hi #4A2375  tint   #F2ECFA   (buttons, links, focus)
violet   #8764B8   magenta  #C239B3   cyan   #50E6FF   (accents; cyan reserved for LIVE/listening)
t1       #241F1A   t2       #6B6257   t3     #9A9085
line     #E0D7C9   line-2   #CFC3B1
ok       #1E7A5C   warn     #9A6B1F   bad    #A33D2E
display font  Bricolage Grotesque (700-800, optical sizing on)
body font     Literata (line-height 1.65-1.7)
radius        card 20px · control 12px · pill 999px
shadow        0 2px 4px rgba(36,31,26,.04), 0 16px 40px -16px rgba(36,31,26,.16)
```

Layout rules that come with it: **one content width** (`--col: 1320px`, `--gutter: 32px`), an
asymmetric 64/36 stage grid (never 50/50), a real header band, and the live interview screen fits
**exactly one viewport** with the transcript as the only scroller.

Two layout traps found while building the mockup and worth carrying into the implementation:

- `height: 100%` on a child of a padded flex item resolves against the padded box in practice and
  ate the 24px bottom gutter. Use a pure flex chain (`flex: 1 1 auto; min-height: 0`) at every
  level instead.
- A default `auto` grid row is sized from content **first**, so the transcript's natural height
  (651px) pushed the row past the available 628px and both cards overflowed the viewport by 23px.
  The row must be `minmax(0, 1fr)`.

## 4b. The implementation got the layout WRONG first — recorded because the reason is reusable

v0.41.0.0 claimed to implement D-purple and shipped **variant B's layout wearing D's palette**: a
440px form card centred on a plain ground, with no editorial split, no display headline, and no
interviewer portrait. The owner spotted it in one glance on the live site. Fixed in v0.41.1.0
(`frontend/src/components/CandidateSignIn.tsx`).

The palette and the typefaces were right, which is exactly why it survived review. The causal chain,
because "be more careful" is not a fix:

1. **The abstraction was built before the artifact.** `AppShell`'s four "measures"
   (wide / reading / narrow / fill) were invented during implementation and appear in no approved
   document. Screens were then mapped onto them, and the sign-in screen got `narrow` because a login
   form is narrow. At that point the abstraction became the spec.
2. **The approved artifact was never opened while implementing.** `D-purple-login.html` and
   `.png` sat in the designs directory the whole time; the work was done from a remembered summary
   of the direction ("warm sand, Bricolage, purple"). A design IS its composition, and composition
   is the part that does not survive being remembered as adjectives.
3. **An approved element was deleted, with a justification committed next to it.** The tagline was
   the hero headline. In a centred card it had nowhere to go, so it was moved into the header band
   and described in a code comment as fixing an "orphan". The design was fighting the wrong
   structure and the friction was read as a defect in the design.
4. **The verification could not have caught it.** Every live check was a THEME property — body
   background, button colour, font family, `<h1>` count, fonts loaded, provider transparent — and
   every one passes identically on the wrong layout. The render was never compared to the approved
   image.

What is in place now so the same miss is not available: `CandidateSignIn.test.tsx` asserts the
COMPOSITION (two asymmetric columns, the tagline rendered at display size, the portrait present and
pointing at the default interviewer), and it is proven to fail when the split is flattened to one
column. Token tests do not substitute for that.

## 5. What shipped

All of the plan below landed in the same change. Gates at the time of writing: `vitest` 50 files /
569 tests green, `tsc --noEmit` clean, `eslint --max-warnings 0` clean. Verified in the running app
at 1440×900 and 390px: one `<h1>` on the page (was two), `document.body` background
`rgb(245,241,234)`, the primary button `rgb(92,46,145)`, both self-hosted faces reporting
`status: loaded`, and no horizontal overflow at 390px.

New files: `frontend/src/theme.ts` (palette, font stacks, brand ramp, token overrides, layout
scale), `frontend/src/components/AppShell.tsx` (header band + the four measures),
`frontend/src/styles/global.css` (self-hosted `@font-face`, page ground, autofill override,
reduced-motion), `frontend/public/fonts/*.woff2`.

Three things differ from the original plan and are worth recording:

- **Fonts are self-hosted, not a `fonts.googleapis.com` link.** This product is delivered into
  client tenants whose candidates sit in mainland China, where Google Fonts is unreachable — a CDN
  link there silently falls back to a system font and collapses the typographic direction exactly
  where the client is. Three latin-subset variable `woff2` files, 206 KB total, served from our own
  origin. Neither face carries CJK, so Chinese resolves through the fallback chain by design
  (Latin → Bricolage/Literata, Chinese → PingFang SC / Microsoft YaHei), made explicit with
  `unicode-range`.
- **A fourth measure, `reading` (760px), exists.** 760px was never wrong *as a measure* — ~75
  characters is right for prose. The defect was that it was one of three widths nested inside each
  other. It is now a named choice in `layout`, used by orientation / review / scoring / report.
- **`avatarBackground` now reads `palette.ground`, not `colorNeutralBackground1`.** The mechanism
  that tells Azure what colour to paint behind the digital human read the Fluent surface token,
  because the FluentProvider root used to paint the page white. That root is transparent now and
  the ground is painted on `html`/`body`, so the surface token is one shade lighter than what is
  actually behind the stage — reading it would have put a visible rectangle back around the
  interviewer, the exact defect the mechanism exists to prevent. The guarding test
  (`InterviewPage.videoToggle.test.tsx`) was updated to assert the ground and to additionally
  require a six-digit hex, since `buildWsUrl` silently drops anything else.

### The plan as executed

1. Replace bare `webLightTheme` with `createLightTheme` + a `BrandVariants` ramp generated from
   `#5C2E91`, plus token overrides for ground/surface/line/text (`frontend/src/App.tsx:11`).
2. Load Bricolage Grotesque + Literata and override Fluent's `fontFamilyBase` / display sizes.
3. Add a shared app-shell component: real header band, one `--col` content width, `--gutter`.
   Delete the inline-styled header at `App.tsx:12-20`.
4. Delete the nested centring: `LoginCard` loses its own `maxWidth`/`margin: 0 auto`
   (`LoginCard.tsx:15`); the page shell owns width.
5. Collapse the 760 / 1400 split in `InterviewPage.tsx` to the single shared width.
6. Fix the button defects: explicit `gap` + spacing on the Restart/Sign out row, intentional
   width on the orientation primary button.
7. Switch inputs off Fluent's filled look to an outline treatment with a purple focus ring.
8. Carry the same tokens into `/admin` and `/admin/agent` (not part of the approved mockups, but
   they share `App.tsx`'s provider so they inherit the theme automatically — they need a layout
   pass of their own afterwards).

Tests to keep green per [the CI gates](../../CLAUDE.md): `vitest run`, `eslint . --max-warnings 0`,
`tsc --noEmit`, plus the Playwright specs that assert on `data-testid` hooks — the refresh must not
rename any `data-testid`.
