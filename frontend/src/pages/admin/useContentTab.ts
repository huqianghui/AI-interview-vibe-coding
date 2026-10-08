/** State and actions of the admin page's Content tab: banks, their questions, and the selected
 * question's scoring rubric (F2b/F3b). Called by AdminPage, so the state outlives tab switches. */
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as admin from "../../api/admin";
import type {
  AdminQuestion,
  Bank,
  Checklist,
  ChecklistItem,
  PublishResult,
} from "../../api/admin";
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

  // Every draft edit reloads the banks' publish state, so reloads can overlap; only the newest
  // one's answer is kept, or a slow older reply could disable Publish on a stale "no changes".
  const banksRequest = useRef(0);
  const loadBanks = useCallback(async () => {
    const mine = ++banksRequest.current;
    const next = await admin.listBanks();
    if (mine === banksRequest.current) setBanks(next);
  }, []);
  const refreshBanks = useCallback(() => guard(loadBanks), [guard, loadBanks]);
  // The outcome of the last publish of the selected bank (version, or why it was refused).
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const [publishing, setPublishing] = useState(false);

  // Every draft edit (question or rubric) can change whether the bank has unpublished changes,
  // so the banks' publish state is reloaded with it.
  const setQuestionsAndStatus = (next: AdminQuestion[]) => {
    setQuestions(next);
    setPublishResult(null);
    void refreshBanks();
  };

  const publishBank = () =>
    guard(async () => {
      if (!selectedBank || publishing) return;
      setPublishing(true);
      try {
        setPublishResult(await admin.publishBank(selectedBank));
        await loadBanks();
      } finally {
        setPublishing(false);
      }
    });

  // Adopt a freshly loaded/generated/saved checklist as both the display + edit state.
  const adoptChecklist = (c: Checklist | null) => {
    setChecklist(c);
    setEditItems(c ? c.items.map((it) => ({ ...it })) : []);
  };

  const loadQuestions = (bankId: string) =>
    guard(async () => {
      setSelectedBank(bankId);
      setPublishResult(null);
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

  // A citation relocation rewrote the draft: refresh the banks' publish state and the open rubric.
  // Stable (the panel's effect depends on it); reads the open question through a ref.
  const openQuestion = useRef<string | null>(null);
  openQuestion.current = selectedQuestion;
  const unsaved = useRef(false);
  unsaved.current =
    checklist !== null && JSON.stringify(editItems) !== JSON.stringify(checklist.items);
  const reloadAfterRelocate = useCallback(() => {
    void guard(async () => {
      await loadBanks();
      const questionId = openQuestion.current;
      if (!questionId) return;
      try {
        const fresh = await admin.getChecklist(questionId);
        setChecklist(fresh);
        // Unsaved edits in the open rubric are kept: the admin saves or reloads them knowingly.
        if (!unsaved.current) setEditItems(fresh.items.map((it) => ({ ...it })));
      } catch {
        // none drafted
      }
    });
  }, [guard, loadBanks]);

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
        source_document_id: null,
        advisory: false,
        source_refs: [],
        order_index: items.length,
      },
    ]);

  // Persist edited items. Backend re-normalizes weights to 100 (forbidden → 0), drops invalid
  // kinds, and returns the saved checklist — adopt it so the editor round-trips (save → reload).
  const saveChecklist = () =>
    guard(async () => {
      if (!checklist) return;
      // Every field the backend stores, including the SOP link and the advisory flag: omitting them
      // is what used to strip both on every save.
      const payload = editItems.map((it) => ({
        kind: it.kind,
        text: it.text,
        weight: it.weight,
        source_quote: it.source_quote,
        source_page: it.source_page,
        source_document_id: it.source_document_id ?? null,
        advisory: it.advisory ?? false,
        source_refs: (it.source_refs ?? []).map((r) => ({
          document_id: r.document_id,
          section: r.section,
        })),
      }));
      adoptChecklist(await admin.editChecklistItems(checklist.checklist_id, payload));
      setChecklistStatus(t("admin.saved"));
      setPublishResult(null);
      await loadBanks();
    });

  // (Re)generate a checklist from the question via AI, then refresh the question list so the
  // rubric-status marker reflects the new item count.
  const generateChecklist = () =>
    guard(async () => {
      if (!selectedQuestion) return;
      adoptChecklist(await admin.draftChecklist(selectedQuestion));
      setChecklistStatus(t("admin.generated"));
      if (selectedBank) setQuestionsAndStatus(await admin.listBankQuestions(selectedBank));
    });

  // Live weight total of the working copy (forbidden items count as their entered weight in the
  // preview; the backend zeros them on save). Purely informational — save re-normalizes to 100.
  const editWeightsSum = editItems.reduce((sum, it) => sum + (it.weight || 0), 0);

  return {
    banks,
    selectedBank,
    questions,
    setQuestions: setQuestionsAndStatus,
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
    publishing,
    reloadAfterRelocate,
  };
}

export type ContentTabState = ReturnType<typeof useContentTab>;
