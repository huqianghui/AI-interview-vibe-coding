/** The line below every paged admin table, so they all look and behave the same (owner,
 * 2026-10-09: the SOP table works like Interview results): "1–20 of 26", rows per page,
 * Previous / Page 1 of 2 / Next. */
import { useTranslation } from "react-i18next";
import { Button, Select, Spinner, Text } from "@fluentui/react-components";
import { PAGE_SIZES, useTableToolbarStyles } from "./tableToolbar";

export function TablePager({
  total,
  page,
  pageSize,
  onPage,
  onPageSize,
  loading = false,
  testId,
}: {
  total: number;
  page: number;
  pageSize: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
  loading?: boolean;
  /** Prefix for the pager's test ids: `<testId>-pager`, `-page-size`, `-prev`, `-page`, `-next`. */
  testId: string;
}) {
  const styles = useTableToolbarStyles();
  const { t } = useTranslation();
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <div className={styles.pager} data-testid={`${testId}-pager`}>
      <Text>
        {loading ? (
          <Spinner size="tiny" label={t("history.loading")} />
        ) : (
          t("admin.results.range", { from, to, total })
        )}
      </Text>
      <div className={styles.pagerControls}>
        <Text wrap={false} className={styles.pagerText}>
          {t("admin.results.perPage")}
        </Text>
        <Select
          className={styles.control}
          value={String(pageSize)}
          onChange={(_, d) => onPageSize(Number(d.value))}
          data-testid={`${testId}-page-size`}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
        <Button
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
          data-testid={`${testId}-prev`}
        >
          {t("admin.results.prev")}
        </Button>
        <Text wrap={false} className={styles.pagerText} data-testid={`${testId}-page`}>
          {t("admin.results.page", { page: page + 1, pages: pageCount })}
        </Text>
        <Button
          disabled={page + 1 >= pageCount}
          onClick={() => onPage(page + 1)}
          data-testid={`${testId}-next`}
        >
          {t("admin.results.next")}
        </Button>
      </div>
    </div>
  );
}
