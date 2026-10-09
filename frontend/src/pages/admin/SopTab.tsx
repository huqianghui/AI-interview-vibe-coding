/** Admin "SOP documents" tab: each SOP's conversion to Markdown, its key-points summary, its
 * sections, and any section's full passage (spec-sop-section-grounding). This is where an admin
 * checks a document was split correctly, and edits and approves its summary: only an approved
 * summary is used in scoring. */
import { useTranslation } from "react-i18next";
import {
  Badge,
  Body1,
  Button,
  Card,
  CardHeader,
  Text,
  Textarea,
  Title3,
} from "@fluentui/react-components";
import type { SopDocument } from "../../api/admin";
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

function summaryLabel(status: string, busy: boolean, t: T): string {
  if (busy) return t("admin.sop.summary.drafting");
  if (status === "reviewed" || status === "draft" || status === "failed") {
    return t(`admin.sop.summary.${status}`);
  }
  return t("admin.sop.summary.none");
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
        action={<SummaryBadge status={summary.status} busy={state.summarizing} />}
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
      id: "summary",
      header: t("admin.sop.colSummary"),
      text: (d) => summaryLabel(d.summary_status, d.summarizing, t),
      pad: 24, // the badge's own padding
      cell: (d) => <SummaryBadge status={d.summary_status} busy={d.summarizing} />,
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
        <DataTable
          size="small"
          testId="sop-documents"
          items={state.documents}
          getRowId={(d) => d.document_id}
          rowProps={(d) => ({
            "data-testid": `sop-doc-${d.document_id}`,
            "aria-selected": d.document_id === state.selected,
          })}
          columns={columns}
        />
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
