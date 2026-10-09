/** DI's markers, turned into Markdown before rendering. A selection mark that starts a line is a
 * checkbox item (DI writes one per line); one inside a sentence is shown as ☒ / ☐. */
export function prepareMarkdown(text: string): string {
  return text
    .replace(/^[ \t]*<!--\s*PageBreak\s*-->[ \t]*$/gm, "\n\n---\n\n")
    // Markdown stops at six levels; DI writes a deeper Word heading with 7+ "#" ("######## 7.
    // APPENDICES"), which would show as raw text. It is shown as the deepest heading instead.
    .replace(/^([ \t]*)#{7,}(?=[ \t])/gm, "$1######")
    .replace(/^([ \t]*):selected:[ \t]*/gm, "$1- [x] ")
    .replace(/^([ \t]*):unselected:[ \t]*/gm, "$1- [ ] ")
    .replace(/:unselected:/g, "☐")
    .replace(/:selected:/g, "☒");
}
