/** Admin "SOP documents" tab: each SOP's conversion to Markdown, its sections, and any section's
 * full passage (spec-sop-section-grounding). Read-only apart from "Convert again": this is where
 * an admin checks a document was split correctly before its sections are cited and scored. */
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
  Title3,
} from "@fluentui/react-components";
import type { SopDocument } from "../../api/admin";
import { useAdminStyles } from "./shared";
import type { SopTabState } from "./useSopTab";

function ConversionBadge({ doc }: { doc: SopDocument }) {
  const { t } = useTranslation();
  if (doc.markdown_source === "") {
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
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

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
