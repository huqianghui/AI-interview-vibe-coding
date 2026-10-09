/** Renders an SOP's Markdown (a section's full text) as a document, not as plain text: headings,
 * lists, pipe tables and task lists (GitHub-flavoured Markdown), and the HTML tables Document
 * Intelligence writes (`<table>` with merged cells). The text comes from uploaded documents, so the
 * HTML is sanitised: no scripts, styles, event handlers or links that run code. DI's page markers
 * (`<!-- PageBreak -->`) become a thin rule, its other comments (page headers, footers) are dropped,
 * and its selection marks (`:selected:` / `:unselected:`) are checkboxes. A single line break is
 * kept: in a converted document it is a real one (a clause number on its own line). */
import { makeStyles, tokens } from "@fluentui/react-components";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { prepareMarkdown } from "./markdownText";

// GitHub's schema, plus the merged-cell attributes DI's tables use, minus images: an uploaded
// document must not make the admin's browser fetch a remote URL (SOP text carries no images).
const schema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((tag) => tag !== "img"),
  attributes: {
    ...defaultSchema.attributes,
    td: [...(defaultSchema.attributes?.td ?? []), "colSpan", "rowSpan"],
    th: [...(defaultSchema.attributes?.th ?? []), "colSpan", "rowSpan"],
  },
};

const useStyles = makeStyles({
  root: {
    lineHeight: 1.6,
    overflowWrap: "anywhere",
    "& h1, & h2, & h3, & h4, & h5, & h6": { margin: "16px 0 8px", lineHeight: 1.3 },
    "& h1": { fontSize: tokens.fontSizeBase600 },
    "& h2": { fontSize: tokens.fontSizeBase500 },
    "& h3, & h4, & h5, & h6": { fontSize: tokens.fontSizeBase400 },
    "& p": { margin: "0 0 8px" },
    "& ul, & ol": { margin: "0 0 8px", paddingLeft: "24px" },
    "& hr": { border: "none", borderTop: `1px dashed ${tokens.colorNeutralStroke2}`, margin: "16px 0" },
    // Tables keep their own width and scroll sideways when wider than the card.
    "& table": {
      borderCollapse: "collapse",
      margin: "8px 0 12px",
      display: "block",
      overflowX: "auto",
      maxWidth: "100%",
    },
    "& th, & td": {
      border: `1px solid ${tokens.colorNeutralStroke2}`,
      padding: "4px 8px",
      verticalAlign: "top",
      textAlign: "left",
    },
    "& th": { backgroundColor: tokens.colorNeutralBackground3, fontWeight: tokens.fontWeightSemibold },
    // A checkbox item shows its box, not a bullet as well.
    "& li.task-list-item": { listStyleType: "none", marginLeft: "-20px" },
    "& input[type=checkbox]": { marginRight: "6px" },
    "& code": { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
  },
});

export function MarkdownView({ text, testId }: { text: string; testId?: string }) {
  const styles = useStyles();
  return (
    <div className={styles.root} data-testid={testId}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]}
      >
        {prepareMarkdown(text)}
      </ReactMarkdown>
    </div>
  );
}
