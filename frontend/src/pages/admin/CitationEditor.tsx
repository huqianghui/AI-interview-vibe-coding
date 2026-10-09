/** The SOP passages one rubric item cites (spec-sop-section-grounding §3): a chip per citation,
 * and "Cite a section" to add one by picking a document, then one of its units, the same sections
 * the SOP tab shows and search proposes (500-4000 characters; a merged unit is one run "1–3").
 * Scoring reads each cited passage in full. */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dropdown, Option, Tag, TagGroup, Text, tokens } from "@fluentui/react-components";
import * as admin from "../../api/admin";
import type { SopDocument, SopUnit, SourceRef } from "../../api/admin";
import { sectionName } from "../../api/client";

/** A unit's titles without its number range: the chip adds the range back ("1–3 …"). */
function unitTitle(u: SopUnit): string {
  const span = u.through ? `${u.section}–${u.through}` : u.section;
  const title = u.label.startsWith(`${span} `) ? u.label.slice(span.length + 1) : u.label;
  // The chip says "(part k)" itself: the label's "(k/n)" is not repeated.
  return u.piece ? title.replace(/ \(\d+\/\d+\)$/, "") : title;
}

export function CitationEditor({
  refs,
  index,
  onChange,
  libraryId,
}: {
  refs: SourceRef[];
  index: number;
  onChange: (refs: SourceRef[]) => void;
  /** The bank's SOP library: only its documents can be cited (spec-sop-libraries). */
  libraryId: string | null;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [documents, setDocuments] = useState<SopDocument[]>([]);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [sections, setSections] = useState<SopUnit[]>([]);
  const [error, setError] = useState<string | null>(null);

  const startAdding = async () => {
    setAdding(true);
    setError(null);
    try {
      const docs = await admin.listSopDocuments();
      setDocuments(docs.filter((d) => d.section_count > 0 && d.library_id === libraryId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const pickDocument = async (id: string) => {
    setDocumentId(id);
    setSections([]);
    try {
      setSections(await admin.listSopUnits(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const pickSection = (value: string) => {
    const doc = documents.find((d) => d.document_id === documentId);
    const unit = sections.find((u) => String(u.index) === value);
    if (!doc || !unit) return;
    const ref: SourceRef = {
      ...admin.unitRef(doc.document_id, unit),
      document_name: doc.name,
      title: unitTitle(unit),
      page_start: unit.page_start,
      found: true,
    };
    const duplicate = refs.some(
      (r) =>
        r.document_id === ref.document_id &&
        r.section === ref.section &&
        (r.through ?? "") === (ref.through ?? "") &&
        (r.part ?? "") === (ref.part ?? "") &&
        (r.piece ?? 0) === (ref.piece ?? 0),
    );
    if (!duplicate) onChange([...refs, ref]);
    setAdding(false);
    setDocumentId(null);
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", minWidth: 0 }}>
      <Text size={200}>{t("admin.citations")}</Text>
      {refs.length === 0 && (
        <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
          {t("admin.noCitation")}
        </Text>
      )}
      {/* The tags wrap onto as many lines as they need and never run past the card; a label too
          long for the line ends in "…" and shows whole on hover. */}
      <TagGroup
        data-testid={`checklist-citations-${index}`}
        onDismiss={(_, d) => onChange(refs.filter((_r, i) => String(i) !== d.value))}
        style={{ display: "flex", flexWrap: "wrap", gap: 6, minWidth: 0, maxWidth: "100%" }}
      >
        {refs.map((r, i) => {
          const label =
            (r.document_name ? `${r.document_name} · ` : "") +
            sectionName(r) +
            (r.found === false ? ` (${t("admin.citationGone")})` : "");
          return (
            <Tag
              key={`${r.document_id}:${r.section}:${r.through ?? ""}:${r.part ?? ""}:${r.piece ?? 0}`}
              value={String(i)}
              size="small"
              dismissible
              dismissIcon={{ "aria-label": t("admin.removeCitation") }}
              appearance={r.found === false ? "outline" : "brand"}
              title={label}
              style={{ maxWidth: "100%", minWidth: 0 }}
              primaryText={{
                children: label,
                style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
              }}
            />
          );
        })}
      </TagGroup>
      {libraryId === null ? null : !adding ? (
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
              {sections.map((u) => (
                <Option key={u.index} value={String(u.index)} text={u.label}>
                  {u.label || t("admin.sop.preamble")}
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
