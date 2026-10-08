/** State of the admin page's SOP tab: every SOP document, the selected one's key-points summary
 * and sections, and the selected section's full text (spec-sop-section-grounding). Loaded each time
 * the tab opens. Conversion and summary drafting run in the background, so while any document is
 * busy the list is polled, and the selected document reloads when its work finishes. */
import { useCallback, useEffect, useRef, useState } from "react";
import * as admin from "../../api/admin";
import type { SopDocument, SopSection, SopSectionText, SopSummary } from "../../api/admin";

export const SOP_POLL_MS = 3000;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const inProgress = (d: SopDocument) =>
  d.converting || d.summarizing || d.markdown_source === "";

export function useSopTab(active: boolean) {
  const [documents, setDocuments] = useState<SopDocument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sections, setSections] = useState<SopSection[]>([]);
  const [section, setSection] = useState<SopSectionText | null>(null);
  const [summary, setSummary] = useState<SopSummary | null>(null);
  // The admin's edit in the summary box; reset whenever a summary is (re)loaded.
  const [summaryText, setSummaryText] = useState("");
  const [savingSummary, setSavingSummary] = useState(false);
  // The document the latest click asked for: a slower answer for an earlier click is dropped.
  const wanted = useRef<string | null>(null);

  const loadSections = useCallback(async (documentId: string) => {
    try {
      const rows = await admin.listSopSections(documentId);
      if (wanted.current === documentId) setSections(rows);
    } catch (e) {
      if (wanted.current === documentId) {
        setSections([]);
        setError(message(e));
      }
    }
  }, []);

  const showSummary = useCallback((loaded: SopSummary) => {
    setSummary(loaded);
    setSummaryText(loaded.summary);
  }, []);

  const loadSummary = useCallback(
    async (documentId: string) => {
      try {
        const loaded = await admin.getSopSummary(documentId);
        if (wanted.current === documentId) showSummary(loaded);
      } catch (e) {
        if (wanted.current === documentId) setError(message(e));
      }
    },
    [showSummary],
  );

  const loadDocuments = useCallback(async () => {
    setError(null);
    try {
      setDocuments(await admin.listSopDocuments());
    } catch (e) {
      setError(message(e));
    }
  }, []);

  useEffect(() => {
    if (active) void loadDocuments();
  }, [active, loadDocuments]);

  const anyInProgress = documents.some(inProgress);
  useEffect(() => {
    if (!active || !anyInProgress) return;
    const timer = setInterval(() => void loadDocuments(), SOP_POLL_MS);
    return () => clearInterval(timer);
  }, [active, anyInProgress, loadDocuments]);

  // The selected document finished converting: show its new sections.
  const current = documents.find((d) => d.document_id === selected);
  const currentBusy = current ? inProgress(current) : false;
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !currentBusy && selected) {
      setSection(null);
      void loadSections(selected);
      void loadSummary(selected);
    }
    wasBusy.current = currentBusy;
  }, [currentBusy, selected, loadSections, loadSummary]);

  const openDocument = async (documentId: string) => {
    wanted.current = documentId;
    wasBusy.current = false;
    setSelected(documentId);
    setSection(null);
    setSections([]);
    setSummary(null);
    setSummaryText("");
    setError(null);
    await Promise.all([loadSections(documentId), loadSummary(documentId)]);
  };

  // approve = true puts the summary into scoring; false keeps it a draft (not used).
  const saveSummary = async (approve: boolean) => {
    const documentId = selected;
    if (!documentId || savingSummary) return;
    setSavingSummary(true);
    setError(null);
    try {
      const saved = await admin.saveSopSummary(documentId, summaryText, approve);
      if (wanted.current === documentId) showSummary(saved);
      await loadDocuments();
    } catch (e) {
      setError(message(e));
    } finally {
      setSavingSummary(false);
    }
  };

  const redraftSummary = async () => {
    const documentId = selected;
    if (!documentId || currentBusy) return;
    setError(null);
    try {
      await admin.redraftSopSummary(documentId);
      await loadDocuments();
    } catch (e) {
      setError(message(e));
    }
  };

  const openSection = async (orderIndex: number) => {
    const documentId = selected;
    if (!documentId) return;
    try {
      const text = await admin.getSopSection(documentId, orderIndex);
      if (wanted.current === documentId) setSection(text);
    } catch (e) {
      setError(message(e));
    }
  };

  const rebuild = async () => {
    if (!selected || currentBusy) return;
    setError(null);
    try {
      const updated = await admin.rebuildSopDocument(selected);
      setDocuments((prev) => prev.map((d) => (d.document_id === updated.document_id ? updated : d)));
    } catch (e) {
      setError(message(e));
    }
  };

  return {
    documents,
    error,
    selected,
    sections,
    section,
    summary,
    summaryText,
    setSummaryText,
    savingSummary,
    summarizing: current?.summarizing ?? false,
    rebuilding: currentBusy,
    loadDocuments,
    openDocument,
    openSection,
    rebuild,
    saveSummary,
    redraftSummary,
  };
}

export type SopTabState = ReturnType<typeof useSopTab>;
