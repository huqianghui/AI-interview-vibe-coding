import { describe, expect, it } from "vitest";
import { citationText, sectionName } from "./client";

describe("citation text", () => {
  it("names each section, the document once per run, and the primary page", () => {
    expect(
      citationText({
        source_page: null,
        source_sections: [
          { document_id: "a", document_name: "A.pdf", section: "4.2", title: "Approval", page: 4 },
          { document_id: "a", document_name: "A.pdf", section: "§2", title: "Scope", page: 5 },
          { document_id: "b", document_name: "B.docx", section: "12", title: "Issues", page: null },
        ],
      }),
    ).toBe("A.pdf · 4.2 Approval, Scope; B.docx · 12 Issues · p. 4");
  });

  it("falls back to the page label without sections, and names an untitled section by number", () => {
    expect(citationText({ source_page: "p.7" })).toBe("p.7");
    expect(citationText({ source_page: null, source_sections: [] })).toBe("");
    expect(sectionName({ section: "§3" })).toBe("§3");
  });
});
