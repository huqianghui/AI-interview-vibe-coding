/** State of the admin page's SOP tab: every SOP document, the selected one's sections, and the
 * selected section's full text (spec-sop-section-grounding). Loaded each time the tab opens.
 * Conversion runs in the background, so while any document is converting the list is polled, and
 * the selected document's sections reload when its conversion finishes. */
import { useCallback, useEffect, useRef, useState } from "react";
import * as admin from "../../api/admin";
import type { SopDocument, SopSection, SopSectionText } from "../../api/admin";

export const SOP_POLL_MS = 3000;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const inProgress = (d: SopDocument) => d.converting || d.markdown_source === "";

export function useSopTab(active: boolean) {
  const [documents, setDocuments] = useState<SopDocument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sections, setSections] = useState<SopSection[]>([]);
  const [section, setSection] = useState<SopSectionText | null>(null);
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
    }
    wasBusy.current = currentBusy;
  }, [currentBusy, selected, loadSections]);

  const openDocument = async (documentId: string) => {
    wanted.current = documentId;
    wasBusy.current = false;
    setSelected(documentId);
    setSection(null);
    setSections([]);
    setError(null);
    await loadSections(documentId);
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
    rebuilding: currentBusy,
    loadDocuments,
    openDocument,
    openSection,
    rebuild,
  };
}

export type SopTabState = ReturnType<typeof useSopTab>;
