/** The SOP sections one rubric item cites (spec-sop-section-grounding §3): a chip per section, and
 * "Cite a section" to add one by picking a document, then one of its sections. Scoring reads each
 * cited section's FULL text, so citing the most specific subsection keeps the prompt small. */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dropdown, Option, Tag, TagGroup, Text, tokens } from "@fluentui/react-components";
import * as admin from "../../api/admin";
import type { SopDocument, SopSection, SourceRef } from "../../api/admin";
import { sectionName } from "../../api/client";

export function CitationEditor({
  refs,
  index,
  onChange,
}: {
  refs: SourceRef[];
  index: number;
  onChange: (refs: SourceRef[]) => void;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [documents, setDocuments] = useState<SopDocument[]>([]);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [sections, setSections] = useState<SopSection[]>([]);
  const [error, setError] = useState<string | null>(null);

  const startAdding = async () => {
    setAdding(true);
    setError(null);
    try {
      const docs = await admin.listSopDocuments();
      setDocuments(docs.filter((d) => d.section_count > 0));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const pickDocument = async (id: string) => {
    setDocumentId(id);
    setSections([]);
    try {
      setSections(await admin.listSopSections(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const pickSection = (number: string) => {
    const doc = documents.find((d) => d.document_id === documentId);
    const section = sections.find((s) => s.number === number);
    if (!doc || !section) return;
    const ref: SourceRef = {
      document_id: doc.document_id,
      document_name: doc.name,
      section: section.number,
      title: section.title,
      page_start: section.page_start,
      found: true,
    };
    const duplicate = refs.some((r) => r.document_id === ref.document_id && r.section === ref.section);
    if (!duplicate) onChange([...refs, ref]);
    setAdding(false);
    setDocumentId(null);
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      <Text size={200}>{t("admin.citations")}</Text>
      {refs.length === 0 && (
        <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
          {t("admin.noCitation")}
        </Text>
      )}
      <TagGroup
        data-testid={`checklist-citations-${index}`}
        onDismiss={(_, d) => onChange(refs.filter((_r, i) => String(i) !== d.value))}
      >
        {refs.map((r, i) => (
          <Tag
            key={`${r.document_id}:${r.section}`}
            value={String(i)}
            size="small"
            dismissible
            dismissIcon={{ "aria-label": t("admin.removeCitation") }}
            appearance={r.found === false ? "outline" : "brand"}
            title={r.found === false ? t("admin.citationGone") : r.document_name}
          >
            {r.document_name ? `${r.document_name} · ` : ""}
            {sectionName(r)}
            {r.found === false ? ` (${t("admin.citationGone")})` : ""}
          </Tag>
        ))}
      </TagGroup>
      {!adding ? (
        <Button size="small" appearance="subtle" data-testid={`checklist-cite-${index}`} onClick={() => void startAdding()}>
          {t("admin.citeSection")}
        </Button>
      ) : (
        <>
          <Dropdown
            aria-label={t("admin.citeDocument")}
            data-testid={`checklist-cite-doc-${index}`}
            placeholder={t("admin.citeDocument")}
            style={{ minWidth: 220 }}
            onOptionSelect={(_, d) => d.optionValue && void pickDocument(d.optionValue)}
          >
            {documents.map((d) => (
              <Option key={d.document_id} value={d.document_id}>
                {d.name}
              </Option>
            ))}
          </Dropdown>
          {documentId && (
            <Dropdown
              aria-label={t("admin.citeSectionPick")}
              data-testid={`checklist-cite-section-${index}`}
              placeholder={t("admin.citeSectionPick")}
              style={{ minWidth: 260 }}
              onOptionSelect={(_, d) => d.optionValue && pickSection(d.optionValue)}
            >
              {sections.map((s) => (
                <Option key={s.order_index} value={s.number} text={sectionName({ section: s.number, title: s.title })}>
                  {`${"  ".repeat(Math.max(0, s.level - 1))}${sectionName({ section: s.number, title: s.title })}`}
                </Option>
              ))}
            </Dropdown>
          )}
          <Button size="small" appearance="subtle" onClick={() => setAdding(false)}>
            {t("admin.cancelCite")}
          </Button>
        </>
      )}
      {error && (
        <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>
          {error}
        </Text>
      )}
    </div>
  );
}
