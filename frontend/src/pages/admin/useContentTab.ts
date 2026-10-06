/** State and actions of the admin page's Content tab: banks, their questions, and the selected
 * question's scoring rubric (F2b/F3b). Called by AdminPage, so the state outlives tab switches. */
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import * as admin from "../../api/admin";
import type { AdminQuestion, Bank, Checklist, ChecklistItem } from "../../api/admin";
import type { Guard } from "./shared";

export function useContentTab(guard: Guard) {
  const { t } = useTranslation();
  const [banks, setBanks] = useState<Bank[]>([]);
  const [selectedBank, setSelectedBank] = useState<string | null>(null);
  const [questions, setQuestions] = useState<AdminQuestion[]>([]);
  const [selectedQuestion, setSelectedQuestion] = useState<string | null>(null);
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  // Working copy of the checklist's items while editing (F3b). Seeded from `checklist` on load and
  // on (re)generate; saved back via editChecklistItems, which re-normalizes weights to 100.
  const [editItems, setEditItems] = useState<ChecklistItem[]>([]);
  const [checklistStatus, setChecklistStatus] = useState<string | null>(null);

  const [newBankName, setNewBankName] = useState("");
  const [newQuestionText, setNewQuestionText] = useState("");

  const refreshBanks = useCallback(
    () => guard(async () => setBanks(await admin.listBanks())),
    [guard],
  );

  // Adopt a freshly loaded/generated/saved checklist as both the display + edit state.
  const adoptChecklist = (c: Checklist | null) => {
    setChecklist(c);
    setEditItems(c ? c.items.map((it) => ({ ...it })) : []);
  };

  const loadQuestions = (bankId: string) =>
    guard(async () => {
      setSelectedBank(bankId);
      setSelectedQuestion(null);
      adoptChecklist(null);
      setChecklistStatus(null);
      setQuestions(await admin.listBankQuestions(bankId));
    });

  const loadChecklist = (questionId: string) =>
    guard(async () => {
      setSelectedQuestion(questionId);
      setChecklistStatus(null);
      try {
        adoptChecklist(await admin.getChecklist(questionId));
      } catch {
        adoptChecklist(null); // none drafted yet
      }
    });

  const setItem = (idx: number, patch: Partial<ChecklistItem>) =>
    setEditItems((items) => items.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  const removeItem = (idx: number) =>
    setEditItems((items) => items.filter((_, i) => i !== idx));

  const addItem = () =>
    setEditItems((items) => [
      ...items,
      {
        kind: "required",
        text: "",
        weight: 0,
        source_quote: "",
        source_page: null,
        order_index: items.length,
      },
    ]);

  // Persist edited items. Backend re-normalizes weights to 100 (forbidden → 0), drops invalid
  // kinds, and returns the saved checklist — adopt it so the editor round-trips (save → reload).
  const saveChecklist = () =>
    guard(async () => {
      if (!checklist) return;
      const payload = editItems.map(({ kind, text, weight, source_quote, source_page }) => ({
        kind,
        text,
        weight,
        source_quote,
        source_page,
      }));
      adoptChecklist(await admin.editChecklistItems(checklist.checklist_id, payload));
      setChecklistStatus(t("admin.saved"));
    });

  // (Re)generate a checklist from the question via AI, then refresh the question list so the
  // rubric-status marker reflects the new item count.
  const generateChecklist = () =>
    guard(async () => {
      if (!selectedQuestion) return;
      adoptChecklist(await admin.draftChecklist(selectedQuestion));
      setChecklistStatus(t("admin.generated"));
      if (selectedBank) setQuestions(await admin.listBankQuestions(selectedBank));
    });

  // Live weight total of the working copy (forbidden items count as their entered weight in the
  // preview; the backend zeros them on save). Purely informational — save re-normalizes to 100.
  const editWeightsSum = editItems.reduce((sum, it) => sum + (it.weight || 0), 0);

  return {
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
  };
}

export type ContentTabState = ReturnType<typeof useContentTab>;
