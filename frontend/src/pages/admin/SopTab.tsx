/** Admin "SOP documents" tab: the SOP libraries (spec-sop-libraries), each listed collapsed and
 * opened by a click to show and upload its documents; then each SOP's conversion to Markdown, its
 * key-points summary, its sections, and any section's full passage (spec-sop-section-grounding).
 * This is where an admin checks a document was split correctly, and edits and approves its
 * summary: only an approved summary is used in scoring. */
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Body1,
  Button,
  Card,
  CardHeader,
  Input,
  Text,
  Textarea,
  Title3,
} from "@fluentui/react-components";
import { ChevronDownRegular, ChevronRightRegular } from "@fluentui/react-icons";
import type { SopDocument, SopLibrary } from "../../api/admin";
import { DataTable, type DataColumn } from "../../components/DataTable";
import { useAdminStyles } from "./shared";
import type { SopTabState } from "./useSopTab";

type T = ReturnType<typeof useTranslation>["t"];

function conversionLabel(doc: SopDocument, t: T): string {
  if (doc.converting || doc.markdown_source === "") return t("admin.sop.pending");
  if (doc.markdown_source === "failed") return t("admin.sop.failed");
  return t(`admin.sop.source.${doc.markdown_source}`, { defaultValue: doc.markdown_source });
}

function ConversionBadge({ doc }: { doc: SopDocument }) {
  const { t } = useTranslation();
  const color =
    doc.converting || doc.markdown_source === ""
      ? "informative"
      : doc.markdown_source === "failed"
        ? "danger"
        : "success";
  return (
    <Badge appearance="tint" color={color}>
      {conversionLabel(doc, t)}
    </Badge>
  );
}

const SUMMARY_COLOR = { reviewed: "success", draft: "warning", failed: "danger" } as const;

/** The summary's state, shown as a badge in the Status column. */
function summaryLabel(status: string, busy: boolean, t: T): string {
  if (busy) return t("admin.sop.summary.drafting");
  if (status === "reviewed" || status === "draft" || status === "failed") {
    return t(`admin.sop.summary.state.${status}`);
  }
  return t("admin.sop.summary.state.none");
}

/** What the state means, in the Notes column: used in scoring or not, or why drafting failed. */
function summaryNote(doc: SopDocument, t: T): string {
  if (doc.summarizing) return "";
  if (doc.summary_status === "failed") return doc.summary_error || t("admin.sop.summary.note.failed");
  if (doc.summary_status === "reviewed") return t("admin.sop.summary.note.reviewed");
  if (doc.summary_status === "draft") return t("admin.sop.summary.note.draft");
  return t("admin.sop.summary.note.none");
}

function SummaryBadge({ status, busy }: { status: string; busy: boolean }) {
  const { t } = useTranslation();
  const color = busy ? "informative" : SUMMARY_COLOR[status as keyof typeof SUMMARY_COLOR];
  return (
    <Badge appearance={color ? "tint" : "outline"} color={color ?? "subtle"}>
      {summaryLabel(status, busy, t)}
    </Badge>
  );
}

function SummaryCard({ state }: { state: SopTabState }) {
  const styles = useAdminStyles();
  const { t } = useTranslation();
  const summary = state.summary;
  if (!summary) return null;
  const busy = state.summarizing || state.savingSummary;
  const edited = state.summaryText.trim() !== summary.summary.trim();
  return (
    <Card className={styles.card} data-testid="sop-summary">
      <CardHeader
        header={<Title3>{t("admin.sop.summary.title")}</Title3>}
        description={<Text size={200}>{t("admin.sop.summary.hint")}</Text>}
        action={
          <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <SummaryBadge status={summary.status} busy={state.summarizing} />
            {!state.summarizing && summary.status !== "failed" && (
              <Text size={200}>
                {t(`admin.sop.summary.note.${summary.status || "none"}`, { defaultValue: "" })}
              </Text>
            )}
          </span>
        }
      />
      {summary.error && (
        <Text size={200} className={styles.errorText}>
          {summary.error}
        </Text>
      )}
      <Textarea
        data-testid="sop-summary-text"
        value={state.summaryText}
        onChange={(_, d) => state.setSummaryText(d.value)}
        resize="vertical"
        rows={12}
        disabled={state.summarizing}
        placeholder={t("admin.sop.summary.placeholder")}
      />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button
          appearance="primary"
          data-testid="sop-summary-approve"
          disabled={busy || !state.summaryText.trim() || (summary.status === "reviewed" && !edited)}
          onClick={() => void state.saveSummary(true)}
        >
          {t("admin.sop.summary.approve")}
        </Button>
        <Button
          data-testid="sop-summary-save"
          disabled={busy || !edited}
          onClick={() => void state.saveSummary(false)}
        >
          {t("admin.sop.summary.saveDraft")}
        </Button>
        <Button
          appearance="subtle"
          data-testid="sop-summary-redraft"
          // Unsaved edits would be replaced by the new draft: save or undo them first.
          disabled={busy || state.rebuilding || edited}
          title={edited ? t("admin.sop.summary.redraftEdited") : undefined}
          onClick={() => void state.redraftSummary()}
        >
          {t("admin.sop.summary.redraft")}
        </Button>
      </div>
    </Card>
  );
}

/** One library: a header that opens and closes it; open, its upload, rename and documents. */
function LibrarySection({
  library,
  state,
  columns,
}: {
  library: SopLibrary;
  state: SopTabState;
  columns: DataColumn<SopDocument>[];
}) {
  const { t } = useTranslation();
  const open = state.expanded.has(library.library_id);
  const docs = state.documents.filter((d) => d.library_id === library.library_id);
  const fileInput = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const id = library.library_id;
  return (
    <section data-testid={`sop-library-${id}`} style={{ borderTop: "1px solid #e8e0d4" }}>
      <Button
        appearance="transparent"
        icon={open ? <ChevronDownRegular /> : <ChevronRightRegular />}
        aria-expanded={open}
        onClick={() => state.toggleLibrary(id)}
        data-testid={`sop-library-toggle-${id}`}
        style={{ justifyContent: "flex-start", width: "100%", padding: "10px 0" }}
      >
        <Text weight="semibold">{library.name}</Text>
        <Text size={200} style={{ marginLeft: 10 }}>
          {t("admin.sop.lib.count", { count: library.document_count })}
        </Text>
      </Button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 0 16px" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept=".pdf,.docx,.txt,.md"
              style={{ display: "none" }}
              data-testid={`sop-library-file-${id}`}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                void state.upload(id, files);
              }}
            />
            <Button
              size="small"
              appearance="primary"
              disabled={state.uploading !== null}
              onClick={() => fileInput.current?.click()}
              data-testid={`sop-library-upload-${id}`}
            >
              {state.uploading === id ? t("admin.sop.lib.uploading") : t("admin.sop.lib.upload")}
            </Button>
            {renaming === null ? (
              <Button size="small" onClick={() => setRenaming(library.name)} data-testid={`sop-library-rename-${id}`}>
                {t("admin.sop.lib.rename")}
              </Button>
            ) : (
              <>
                <Input
                  size="small"
                  value={renaming}
                  onChange={(_, d) => setRenaming(d.value)}
                  aria-label={t("admin.sop.lib.name")}
                  data-testid={`sop-library-name-${id}`}
                />
                <Button
                  size="small"
                  appearance="primary"
                  disabled={!renaming.trim() || renaming.trim() === library.name}
                  onClick={() => {
                    void state.renameLibrary(id, renaming);
                    setRenaming(null);
                  }}
                  data-testid={`sop-library-rename-save-${id}`}
                >
                  {t("admin.sop.lib.save")}
                </Button>
                <Button size="small" onClick={() => setRenaming(null)}>
                  {t("admin.sop.lib.cancel")}
                </Button>
              </>
            )}
            {/* A library that holds documents cannot be deleted (the server refuses it too). */}
            {library.document_count === 0 && (
              <Button
                size="small"
                appearance="subtle"
                onClick={() => void state.deleteLibrary(id)}
                data-testid={`sop-library-delete-${id}`}
              >
                {t("admin.sop.lib.delete")}
              </Button>
            )}
          </div>
          {docs.length === 0 ? (
            <Text size={200} data-testid={`sop-library-empty-${id}`}>
              {t("admin.sop.lib.empty")}
            </Text>
          ) : (
            <DataTable
              size="small"
              testId={`sop-documents-${id}`}
              items={docs}
              getRowId={(d) => d.document_id}
              rowProps={(d) => ({
                "data-testid": `sop-doc-${d.document_id}`,
                "aria-selected": d.document_id === state.selected,
              })}
              columns={columns}
            />
          )}
        </div>
      )}
    </section>
  );
}

function NewLibrary({ state }: { state: SopTabState }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <Input
        size="small"
        value={name}
        placeholder={t("admin.sop.lib.newPlaceholder")}
        onChange={(_, d) => setName(d.value)}
        aria-label={t("admin.sop.lib.name")}
        data-testid="sop-library-new-name"
      />
      <Button
        size="small"
        disabled={!name.trim()}
        onClick={() => {
          void state.createLibrary(name);
          setName("");
        }}
        data-testid="sop-library-new"
      >
        {t("admin.sop.lib.add")}
      </Button>
    </div>
  );
}

export function SopTab({ state }: { state: SopTabState }) {
  const styles = useAdminStyles();
  const { t } = useTranslation();
  const current = state.documents.find((d) => d.document_id === state.selected);
  const columns: DataColumn<SopDocument>[] = [
    {
      id: "name",
      header: t("admin.sop.colName"),
      text: (d) => d.name,
      pad: 24, // the name is a subtle button
      maxWidth: 460, // SOP file names run long; most fit on one line at this width
      cell: (d) => (
        <Button
          appearance="subtle"
          style={{ justifyContent: "flex-start", textAlign: "start" }}
          onClick={() => void state.openDocument(d.document_id)}
        >
          {d.name}
        </Button>
      ),
    },
    {
      id: "conversion",
      header: t("admin.sop.colConversion"),
      long: true,
      // The badge's own padding; a failed conversion's error follows it, on one line until clicked.
      pad: 24,
      text: (d) => [conversionLabel(d, t), d.markdown_error].filter(Boolean).join("  "),
      cell: (d) => (
        <>
          <ConversionBadge doc={d} />
          {d.markdown_error && (
            <Text size={200} className={styles.errorText} style={{ marginLeft: 6 }}>
              {d.markdown_error}
            </Text>
          )}
        </>
      ),
    },
    { id: "sections", header: t("admin.sop.colSections"), text: (d) => String(d.section_count), cell: (d) => d.section_count },
    {
      // The summary itself, one line until clicked (owner, 2026-10-09).
      id: "summary",
      header: t("admin.sop.colSummary"),
      long: true,
      text: (d) => d.summary ?? "",
      cell: (d) => <Text size={200}>{(d.summary ?? "").replace(/\s+/g, " ").trim() || "—"}</Text>,
    },
    {
      id: "status",
      header: t("admin.sop.colStatus"),
      text: (d) => summaryLabel(d.summary_status, d.summarizing, t),
      pad: 24, // the badge's own padding
      cell: (d) => <SummaryBadge status={d.summary_status} busy={d.summarizing} />,
    },
    {
      id: "notes",
      header: t("admin.sop.colNotes"),
      long: true,
      text: (d) => summaryNote(d, t),
      cell: (d) => <Text size={200}>{summaryNote(d, t)}</Text>,
    },
    {
      // Only an SOP nothing cites can be deleted; a cited one is replaced by a new bank or version.
      id: "actions",
      header: "",
      width: 96,
      cell: (d) =>
        // Not while it converts or its summary is drafted: that work would write for a gone row.
        (d.cited_in ?? []).length === 0 && !d.converting && !d.summarizing ? (
          <Button
            size="small"
            appearance="subtle"
            data-testid={`sop-doc-delete-${d.document_id}`}
            onClick={() => void state.deleteDocument(d, t("admin.sop.deleteConfirm", { name: d.name }))}
          >
            {t("admin.sop.delete")}
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <Card className={styles.card}>
        <CardHeader
          header={<Title3>{t("admin.sop.title")}</Title3>}
          description={<Text size={200}>{t("admin.sop.hint")}</Text>}
        />
        {state.error && (
          <Body1 role="alert" className={styles.errorText}>
            {state.error}
          </Body1>
        )}
        {/* One line above the libraries carries every message (owner: tables stay clean). */}
        {state.notice && (
          <Text size={200} data-testid="sop-library-notice">
            {state.notice.uploaded > 0 && t("admin.sop.lib.uploaded", { count: state.notice.uploaded })}
            {state.notice.failed.length > 0 && (
              <span role="alert" className={styles.errorText}>
                {" "}
                {t("admin.sop.lib.uploadFailed", { count: state.notice.failed.length })}{" "}
                {state.notice.failed.join("; ")}
              </span>
            )}
          </Text>
        )}
        <NewLibrary state={state} />
        <div data-testid="sop-libraries">
          {state.libraries.map((lib) => (
            <LibrarySection key={lib.library_id} library={lib} state={state} columns={columns} />
          ))}
        </div>
      </Card>

      {current && <SummaryCard state={state} />}

      {current && (
        <Card className={styles.card}>
          <CardHeader
            header={<Title3>{current.name}</Title3>}
            action={
              <Button
                size="small"
                data-testid="sop-rebuild"
                disabled={state.rebuilding}
                onClick={() => void state.rebuild()}
              >
                {state.rebuilding ? t("admin.sop.rebuilding") : t("admin.sop.rebuild")}
              </Button>
            }
          />
          {state.sections.length === 0 ? (
            <Body1 className={styles.emptyState}>{t("admin.sop.noSections")}</Body1>
          ) : (
            <ul className={styles.list} data-testid="sop-sections">
              {state.sections.map((s) => (
                <li
                  key={s.order_index}
                  className={styles.row}
                  style={{ paddingLeft: (s.level - 1) * 18 }}
                >
                  <Button
                    appearance="subtle"
                    className={styles.rowText}
                    style={{ justifyContent: "flex-start", textAlign: "left" }}
                    data-testid={`sop-section-${s.order_index}`}
                    onClick={() => void state.openSection(s.order_index)}
                  >
                    {s.number.startsWith("§") ? s.title || t("admin.sop.preamble") : `${s.number} ${s.title}`}
                  </Button>
                  <Text size={200} className={styles.emptyState}>
                    {t("admin.sop.sectionMeta", {
                      pages:
                        s.page_start === s.page_end ? s.page_start : `${s.page_start}-${s.page_end}`,
                      chars: s.full_length,
                    })}
                  </Text>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {state.section && (
        <Card className={styles.card} data-testid="sop-section-text">
          <CardHeader
            header={
              <Title3>
                {state.section.number.startsWith("§")
                  ? state.section.title || t("admin.sop.preamble")
                  : `${state.section.number} ${state.section.title}`}
              </Title3>
            }
            description={
              <Text size={200}>
                {t("admin.sop.fullSectionHint", { chars: state.section.full_text.length })}
              </Text>
            }
          />
          <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit" }}>
            {state.section.full_text}
          </pre>
        </Card>
      )}
    </>
  );
}
