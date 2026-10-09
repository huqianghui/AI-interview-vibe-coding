/** DI's markers, turned into Markdown before rendering. A selection mark that starts a line is a
 * checkbox item (DI writes one per line); one inside a sentence is shown as ☒ / ☐. */
export function prepareMarkdown(text: string): string {
  return text
    .replace(/^[ \t]*<!--\s*PageBreak\s*-->[ \t]*$/gm, "\n\n---\n\n")
    .replace(/^([ \t]*):selected:[ \t]*/gm, "$1- [x] ")
    .replace(/^([ \t]*):unselected:[ \t]*/gm, "$1- [ ] ")
    .replace(/:unselected:/g, "☐")
    .replace(/:selected:/g, "☒");
}
