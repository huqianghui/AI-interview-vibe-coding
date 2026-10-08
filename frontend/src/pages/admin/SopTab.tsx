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
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
  Title3,
} from "@fluentui/react-components";
import type { SopDocument } from "../../api/admin";
import { useAdminStyles } from "./shared";
import type { SopTabState } from "./useSopTab";

function ConversionBadge({ doc }: { doc: SopDocument }) {
  const { t } = useTranslation();
  if (doc.converting || doc.markdown_source === "") {
    return <Badge appearance="tint" color="informative">{t("admin.sop.pending")}</Badge>;
  }
  if (doc.markdown_source === "failed") {
    return <Badge appearance="tint" color="danger">{t("admin.sop.failed")}</Badge>;
  }
  return (
    <Badge appearance="tint" color="success">
      {t(`admin.sop.source.${doc.markdown_source}`, { defaultValue: doc.markdown_source })}
    </Badge>
  );
}

function SummaryBadge({ status, busy }: { status: string; busy: boolean }) {
  const { t } = useTranslation();
  if (busy) return <Badge appearance="tint" color="informative">{t("admin.sop.summary.drafting")}</Badge>;
  if (status === "reviewed") {
    return <Badge appearance="tint" color="success">{t("admin.sop.summary.reviewed")}</Badge>;
  }
  if (status === "draft") {
    return <Badge appearance="tint" color="warning">{t("admin.sop.summary.draft")}</Badge>;
  }
  if (status === "failed") {
    return <Badge appearance="tint" color="danger">{t("admin.sop.summary.failed")}</Badge>;
  }
  return <Badge appearance="outline" color="subtle">{t("admin.sop.summary.none")}</Badge>;
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
          disabled={busy || state.rebuilding}
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
        <Table size="small" data-testid="sop-documents">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>{t("admin.sop.colName")}</TableHeaderCell>
              <TableHeaderCell>{t("admin.sop.colConversion")}</TableHeaderCell>
              <TableHeaderCell>{t("admin.sop.colSections")}</TableHeaderCell>
              <TableHeaderCell>{t("admin.sop.colSummary")}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.documents.map((d) => (
              <TableRow
                key={d.document_id}
                data-testid={`sop-doc-${d.document_id}`}
                aria-selected={d.document_id === state.selected}
              >
                <TableCell>
                  <Button appearance="subtle" onClick={() => void state.openDocument(d.document_id)}>
                    {d.name}
                  </Button>
                </TableCell>
                <TableCell>
                  <ConversionBadge doc={d} />
                  {d.markdown_error && (
                    <Text size={200} className={styles.errorText} style={{ marginLeft: 6 }}>
                      {d.markdown_error}
                    </Text>
                  )}
                </TableCell>
                <TableCell>{d.section_count}</TableCell>
                <TableCell>
                  <SummaryBadge status={d.summary_status} busy={d.summarizing} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
