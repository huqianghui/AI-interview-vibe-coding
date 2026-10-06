# Self-hosted fonts

The two faces of the approved design direction (docs/planning/design-ui-refresh-foundry-purple.md),
served from our own origin rather than `fonts.googleapis.com`.

## Why self-hosted

This product is delivered into client tenants whose candidates sit in mainland China, where Google
Fonts is unreachable. A CDN `<link>` there does not error — it silently falls back to a system font,
which collapses the whole typographic direction exactly where the client is. Self-hosting also
removes a third-party request from the candidate's critical path.

## Files

| File | Face | Role | Size |
| --- | --- | --- | --- |
| `bricolage-grotesque-latin-var.woff2` | Bricolage Grotesque, variable 400–800 | Display: wordmark, headings, buttons, labels | 75 KB |
| `literata-latin-var.woff2` | Literata, variable 400–600 | Body: questions, transcript, prose | 47 KB |
| `literata-latin-italic-var.woff2` | Literata italic, 400 | Body italic (in-progress transcript turns) | 84 KB |

| `noto-sans-sc-regular.otf` | Noto Sans SC Regular, unmodified | Report PDF body (answers, SOP quotes) | 8.0 MB |
| `noto-sans-sc-bold-gb2312.otf` | Noto Sans SC Bold, subset | Report PDF headings and labels | 2.0 MB |
| `noto-sans-regular.ttf` | Noto Sans Regular, unmodified | Report PDF fallback: Latin, Greek, Cyrillic | 607 KB |
| `noto-sans-bold.ttf` | Noto Sans Bold, unmodified | Report PDF fallback, bold | 617 KB |

The page faces are 206 KB total. All three are the **latin subset** only, declared with a matching `unicode-range` in
`src/styles/global.css` — neither face carries CJK, so Chinese text resolves through the fallback
chain (PingFang SC / Microsoft YaHei) by design and the browser does not download a latin face to
render a string with no latin in it.

### The Noto Sans SC and Noto Sans files are for the report PDF only

They are never referenced by CSS, so no page load downloads them. `src/components/reportPdf.ts`
fetches them the first time a candidate clicks "Download PDF" (the browser caches them after), and
pdfmake embeds only the glyphs the document uses, so a report PDF is tens of KB, not megabytes. A PDF
cannot fall back to a system font the way a page does: a character missing from the embedded face
prints as nothing, which is why the two faces are chosen as follows.

- **Regular is the unmodified Noto CJK `SubsetOTF/SC` file**, all 30,890 characters. It sets
  everything that is not our own copy: candidate answers, SOP quotes, rationales, question prompts.
  An earlier subset kept only the CJK Unified Ideographs block plus Latin and punctuation, and it
  silently dropped `≤ ≥ ≠ ≈ μ α Ω ✓ ㎎` — exactly what pharma SOP text says ("≤ 25 °C",
  "5 μg/mL"). Two megabytes is cheaper than a candidate record missing characters.
- **Noto Sans (Latin, Greek, Cyrillic) is the fallback** for what Noto Sans SC lacks. Its Latin
  covers only 244 of the 560 Latin-extended slots, so Ł ř ğ ș ő and accented Greek printed as
  boxes: "Łukasz Dvořák", "București", "Ελλάδα", which an EMEA interview meets. pdfmake cannot fall
  back by itself (one font per run), so `reportPdf.ts` splits every string into runs by face:
  Noto Sans SC first, Noto Sans for what only it has. Both weights have the same 2,965 characters,
  from https://github.com/notofonts/notofonts.github.io (`fonts/NotoSans/hinted/ttf/`).
- A character neither face has (an emoji, Hangul, CJK Extension B) prints as a visible □, not as
  nothing: `src/components/pdfGlyphs.ts` lists both faces' characters and `reportPdf.ts` replaces
  the rest. `reportPdf.test.ts` fails if a list and its font disagree, so after replacing a font,
  regenerate its list (the same snippet on `noto-sans-regular.ttf` gives `LATIN_FACE_RUNS`):

  ```bash
  python3 -c "
  from fontTools.ttLib import TTFont
  cps = sorted(TTFont('public/fonts/noto-sans-sc-regular.otf').getBestCmap())
  runs, s, p = [], cps[0], cps[0]
  for c in cps[1:]:
      if c == p + 1: p = c; continue
      runs.append((s, p)); s = p = c
  runs.append((s, p)); print(len(runs), 'runs')" # then rewrite REGULAR_FACE_RUNS in pdfGlyphs.ts
  ```

- **Bold keeps GB2312** (6,763 hanzi plus symbols) plus Latin and punctuation, 2.0 MB, and sets only
  our own labels. `reportPdf.test.ts` asserts every character the PDF prints in bold has a glyph,
  so a new label outside GB2312 fails the test instead of the PDF. Made with fontTools:

  ```bash
  BASE="U+0020-007E,U+00A0-024F,U+2000-206F,U+20A0-20CF,U+2100-218F,U+2190-21FF,U+2460-24FF,U+25A0-25FF,U+3000-303F,U+FF00-FFEF"
  pyftsubset NotoSansSC-Bold.otf --unicodes="$BASE" --text-file=gb2312.txt --layout-features='*' \
    --output-file=noto-sans-sc-bold-gb2312.otf   # gb2312.txt: every character GB2312 encodes
  ```

These two files are served `immutable` for a year (nginx.conf), so a changed face must ship under a
new file name, never the same one.

## Licensing

Both are licensed under the **SIL Open Font License 1.1**, which permits redistribution (including
bundled in an application) provided the licence travels with the files:

- `OFL-Bricolage-Grotesque.txt` — Copyright 2022 The Bricolage Grotesque Project Authors,
  https://github.com/ateliertriay/bricolage
- `OFL-Literata.txt` — Copyright 2017 The Literata Project Authors,
  https://github.com/googlefonts/literata
- `OFL-Noto-Sans.txt` — Noto Sans, Copyright 2022 The Noto Project Authors,
  https://github.com/notofonts/latin-greek-cyrillic. No Reserved Font Name; files unmodified.
- `OFL-Noto-Sans-CJK.txt` — Noto Sans CJK, Copyright 2014-2021 Adobe (http://www.adobe.com/),
  https://github.com/notofonts/noto-cjk. Its licence declares no Reserved Font Name, so the
  subsetted Bold file may keep the name "Noto Sans SC".

Do not rename the font families in the `@font-face` declarations: OFL reserves the original names
only when the font binaries themselves are modified, which these are not (they are the unmodified
Google Fonts latin subsets).

## Updating

Fetch the CSS for the family with a desktop browser `User-Agent` (Google serves woff2 only to
browsers that support it), take the `src:` URL from the block whose `unicode-range` starts at
`U+0000-00FF`, and download it:

```bash
curl -sH "User-Agent: Mozilla/5.0 ... Chrome/120.0 Safari/537.36" \
  "https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,400..600;1,7..72,400&display=swap" \
  | grep -B1 "U+0000-00FF" | grep -o "https://[^)]*woff2"
```

Verify the download really is a font before committing it (a redirect or an error page will happily
save as `.woff2`): `head -c4 file.woff2` must print `wOF2`.
