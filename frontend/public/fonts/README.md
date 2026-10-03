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

206 KB total. All three are the **latin subset** only, declared with a matching `unicode-range` in
`src/styles/global.css` — neither face carries CJK, so Chinese text resolves through the fallback
chain (PingFang SC / Microsoft YaHei) by design and the browser does not download a latin face to
render a string with no latin in it.

## Licensing

Both are licensed under the **SIL Open Font License 1.1**, which permits redistribution (including
bundled in an application) provided the licence travels with the files:

- `OFL-Bricolage-Grotesque.txt` — Copyright 2022 The Bricolage Grotesque Project Authors,
  https://github.com/ateliertriay/bricolage
- `OFL-Literata.txt` — Copyright 2017 The Literata Project Authors,
  https://github.com/googlefonts/literata

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
