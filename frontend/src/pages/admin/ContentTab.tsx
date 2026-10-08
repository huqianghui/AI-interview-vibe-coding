/** The admin page's Content tab: banks, their questions, and the selected question's rubric. */
import { useTranslation } from "react-i18next";
import {
  Badge,
  Body1,
  Button,
  Card,
  CardHeader,
  Dropdown,
  Input,
  Option,
  Text,
  Title3,
  tokens,
} from "@fluentui/react-components";
import * as admin from "../../api/admin";
import type { PublishResult } from "../../api/admin";
import { BoundedIntInput } from "../../components/BoundedIntInput";
import { KIND_COLOR, KINDS, useAdminStyles, type Guard } from "./shared";
import type { ContentTabState } from "./useContentTab";

/** What the last Publish did: the version it made, that nothing changed, or every reason it was
 * refused (an enabled question without a rubric, or weights that do not total 100). */
function PublishOutcome({ result }: { result: PublishResult }) {
  const { t } = useTranslation();
  const styles = useAdminStyles();
  if (result.published) {
    return (
      <Text size={200} className={styles.hintOk} data-testid="bank-publish-result">
        {result.created
          ? t("admin.publishedAs", { no: result.version_no })
          : t("admin.publishUnchanged", { no: result.version_no })}
      </Text>
    );
  }
  return (
    <div role="alert" data-testid="bank-publish-problems">
      <Text size={200} className={styles.hintWarn}>
        {t("admin.publishRefused")}
      </Text>
      <ul className={styles.list}>
        {result.problems.map((p, i) => (
          <li key={i}>
            <Text size={200}>
              {p.code === "no_rubric"
                ? t("admin.problemNoRubric", { no: p.question_no })
                : p.code === "weights"
                  ? t("admin.problemWeights", { no: p.question_no, sum: p.weights_sum })
                  : t("admin.problemNoQuestions")}
              {p.question_text ? ` — ${p.question_text}` : ""}
            </Text>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ContentTab({ state, guard }: { state: ContentTabState; guard: Guard }) {
  const styles = useAdminStyles();
  const { t } = useTranslation();
  const {
    banks,
    selectedBank,
    questions,
    setQuestions,
    selectedQuestion,
    checklist,
    editItems,
    checklistStatus,
    newBankName,
    setNewBankName,
    newQuestionText,
    setNewQuestionText,
    refreshBanks,
    loadQuestions,
    loadChecklist,
    setItem,
    removeItem,
    addItem,
    saveChecklist,
    generateChecklist,
    editWeightsSum,
    publishResult,
    publishBank,
  } = state;
  const currentBank = banks.find((b) => b.bank_id === selectedBank);

  return (
    <>
      {/* Banks */}
      <Card className={styles.card}>
        <CardHeader header={<Title3>{t("admin.banksTitle")}</Title3>} />
        <ul className={styles.list} data-testid="bank-list">
          {banks.map((b) => (
            <li key={b.bank_id} className={styles.row}>
              <Button
                className={styles.rowText}
                appearance="subtle"
                style={{ justifyContent: "flex-start" }}
                onClick={() => loadQuestions(b.bank_id)}
              >
                {b.name}
              </Button>
              <div className={styles.actions}>
                {b.is_default ? (
                  <Badge appearance="tint" color="brand">
                    {t("admin.defaultBadge")}
                  </Badge>
                ) : (
                  <Button
                    size="small"
                    onClick={() =>
                      guard(async () => {
                        await admin.setDefaultBank(b.bank_id);
                        await refreshBanks();
                      })
                    }
                  >
                    {t("admin.makeDefault")}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
        <div className={styles.addRow}>
          <Input
            value={newBankName}
            placeholder={t("admin.newBankPlaceholder")}
            onChange={(_, d) => setNewBankName(d.value)}
          />
          <Button
            onClick={() =>
              guard(async () => {
                if (!newBankName.trim()) return;
                await admin.createBank(newBankName.trim(), banks.length === 0);
                setNewBankName("");
                await refreshBanks();
              })
            }
          >
            {t("admin.addBank")}
          </Button>
        </div>
      </Card>

      {/* Questions in the selected bank */}
      {selectedBank ? (
        <Card className={styles.card}>
          <CardHeader
            header={<Title3>{t("admin.questionsTitle")}</Title3>}
            description={
              <Text size={200} data-testid="bank-version-status" title={t("admin.versionHint")}>
                {currentBank?.latest_version_no != null
                  ? t("admin.versionPublished", { no: currentBank.latest_version_no })
                  : t("admin.versionNeverPublished")}
                {currentBank?.has_unpublished_changes && (
                  <span className={styles.hintWarn}> · {t("admin.versionUnpublished")}</span>
                )}
              </Text>
            }
            action={
              <Button
                appearance="primary"
                size="small"
                data-testid="bank-publish"
                disabled={!currentBank?.has_unpublished_changes}
                onClick={publishBank}
              >
                {t("admin.publish")}
              </Button>
            }
          />
          {publishResult && <PublishOutcome result={publishResult} />}
          <ul className={styles.list} data-testid="question-list">
            {questions.map((q, i) => (
              <li key={q.question_id} className={styles.row}>
                <div className={styles.rowText}>
                  <Text weight="semibold">{q.order_index + 1}.</Text> <Text>{q.text}</Text>
                  <br />
                  <Text
                    size={200}
                    data-testid={`rubric-status-${q.question_id}`}
                    className={q.checklist_item_count > 0 ? styles.hintOk : styles.hintWarn}
                  >
                    {q.checklist_item_count > 0
                      ? t("admin.rubricItems", { count: q.checklist_item_count })
                      : t("admin.rubricNotConfigured")}
                  </Text>
                </div>
                <div className={styles.actions}>
                  {/* Max follow-ups (issue #114): RETIRED as a behaviour since 2026-09-28 — the
                      judge only nudges, it never asks a follow-up or redirects, in every turn
                      mode. The field stays (stored per question, no migration) but has no effect;
                      the hint says so. Linear mode never followed up (a submit always advances,
                      v0.39.2.0). */}
                  <Text size={200} title={t("admin.maxFollowUpsHint")}>
                    {t("admin.maxFollowUps")}
                  </Text>
                  <BoundedIntInput
                    size="small"
                    value={q.max_follow_ups}
                    min={0}
                    max={3}
                    aria-label={t("admin.maxFollowUps")}
                    onCommit={async (v) => {
                      await admin.editQuestion(q.question_id, { max_follow_ups: v });
                      if (selectedBank) setQuestions(await admin.listBankQuestions(selectedBank));
                    }}
                    data-testid={`max-follow-ups-${q.question_id}`}
                  />
                  <Button
                    size="small"
                    appearance={selectedQuestion === q.question_id ? "primary" : "secondary"}
                    onClick={() => loadChecklist(q.question_id)}
                    data-testid={`rubric-btn-${q.question_id}`}
                  >
                    {t("admin.rubricBtn")}
                  </Button>
                  <Button
                    size="small"
                    disabled={i === 0}
                    aria-label={t("admin.moveUp")}
                    onClick={() =>
                      guard(async () => {
                        const ids = questions.map((x) => x.question_id);
                        [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
                        await admin.reorderQuestions(selectedBank, ids);
                        await loadQuestions(selectedBank);
                      })
                    }
                  >
                    ↑
                  </Button>
                  <Button
                    size="small"
                    onClick={() =>
                      guard(async () => {
                        await admin.deleteQuestion(q.question_id);
                        await loadQuestions(selectedBank);
                      })
                    }
                  >
                    {t("admin.delete")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <div className={styles.addRow}>
            <Input
              value={newQuestionText}
              placeholder={t("admin.newQuestionPlaceholder")}
              onChange={(_, d) => setNewQuestionText(d.value)}
              style={{ flex: 1 }}
            />
            <Button
              onClick={() =>
                guard(async () => {
                  if (!newQuestionText.trim()) return;
                  await admin.addBankQuestion(selectedBank, newQuestionText.trim(), []);
                  setNewQuestionText("");
                  await loadQuestions(selectedBank);
                })
              }
            >
              {t("admin.addQuestion")}
            </Button>
          </div>
        </Card>
      ) : (
        <Card className={styles.card}>
          <Body1 className={styles.emptyState}>{t("admin.selectBankHint")}</Body1>
        </Card>
      )}

      {/* Checklist (scoring rubric) for the selected question — editable inline panel (F3b) */}
      {selectedQuestion && (
        <Card className={styles.card}>
          <CardHeader header={<Title3>{t("admin.rubricTitle")}</Title3>} />
          {checklist ? (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <Body1>
                  {t("admin.weightsTotal", {
                    sum: editWeightsSum,
                    count: editItems.length,
                  })}
                  {editWeightsSum !== 100 && (
                    <Text data-testid="checklist-weights-hint" className={styles.hintWarn}>
                      {t("admin.weightsHint")}
                    </Text>
                  )}
                </Body1>
                <div className={styles.weightBar}>
                  <div
                    className={styles.weightBarFill}
                    style={{
                      width: `${Math.min(editWeightsSum, 100)}%`,
                      background:
                        editWeightsSum === 100
                          ? tokens.colorPaletteGreenBackground3
                          : tokens.colorPaletteYellowBackground3,
                    }}
                  />
                </div>
              </div>
              <ul className={styles.list} data-testid="checklist-items">
                {editItems.map((it, i) => (
                  <li key={i} className={styles.checklistItem}>
                    <div className={styles.checklistItemRow}>
                      <Badge appearance="tint" color={KIND_COLOR[it.kind] ?? "informative"}>
                        {it.kind}
                      </Badge>
                      <Dropdown
                        aria-label="Rubric item kind"
                        data-testid={`checklist-kind-${i}`}
                        selectedOptions={[it.kind]}
                        value={it.kind}
                        style={{ minWidth: 150 }}
                        onOptionSelect={(_, d) => setItem(i, { kind: d.optionValue ?? "required" })}
                      >
                        {KINDS.map((k) => (
                          <Option key={k} value={k}>
                            {k}
                          </Option>
                        ))}
                      </Dropdown>
                      <Input
                        value={it.text}
                        placeholder={t("admin.rubricItemPlaceholder")}
                        data-testid={`checklist-text-${i}`}
                        onChange={(_, d) => setItem(i, { text: d.value })}
                        style={{ flex: 1, minWidth: 200 }}
                      />
                      <Input
                        type="number"
                        value={String(it.weight)}
                        data-testid={`checklist-weight-${i}`}
                        onChange={(_, d) => setItem(i, { weight: Number(d.value) || 0 })}
                        style={{ width: 80 }}
                      />
                      <Button
                        size="small"
                        data-testid={`checklist-remove-${i}`}
                        onClick={() => removeItem(i)}
                      >
                        {t("admin.delete")}
                      </Button>
                    </div>
                    {it.advisory && (
                      <Text size={200} data-testid={`checklist-advisory-${i}`}>
                        {t("admin.advisory")}
                      </Text>
                    )}
                    {it.source_quote && (
                      <Text size={200} className={styles.sourceQuote}>
                        “{it.source_quote}”
                        {[it.source_document_name, it.source_page].some(Boolean)
                          ? ` — ${[it.source_document_name, it.source_page].filter(Boolean).join(" · ")}`
                          : ""}
                      </Text>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <Body1 className={styles.emptyState}>{t("admin.noRubric")}</Body1>
          )}
          <div className={styles.addRow} style={{ marginTop: 4 }}>
            <Button data-testid="checklist-add-item" onClick={addItem}>
              {t("admin.addItem")}
            </Button>
            {checklist && (
              <Button appearance="primary" data-testid="checklist-save" onClick={saveChecklist}>
                {t("admin.save")}
              </Button>
            )}
            <Button data-testid="checklist-generate" onClick={generateChecklist}>
              {t("admin.generateAi")}
            </Button>
            {checklistStatus && (
              <Text data-testid="checklist-status" className={styles.hintOk}>
                {checklistStatus}
              </Text>
            )}
          </div>
        </Card>
      )}
    </>
  );
}
