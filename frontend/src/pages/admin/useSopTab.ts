/** State of the admin page's SOP tab: every SOP document, the selected one's sections, and the
 * selected section's full text (spec-sop-section-grounding). Loaded each time the tab opens. */
import { useCallback, useEffect, useState } from "react";
import * as admin from "../../api/admin";
import type { SopDocument, SopSection, SopSectionText } from "../../api/admin";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useSopTab(active: boolean) {
  const [documents, setDocuments] = useState<SopDocument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sections, setSections] = useState<SopSection[]>([]);
  const [section, setSection] = useState<SopSectionText | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

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

  const openDocument = async (documentId: string) => {
    setSelected(documentId);
    setSection(null);
    setError(null);
    try {
      setSections(await admin.listSopSections(documentId));
    } catch (e) {
      setSections([]);
      setError(message(e));
    }
  };

  const openSection = async (orderIndex: number) => {
    if (!selected) return;
    try {
      setSection(await admin.getSopSection(selected, orderIndex));
    } catch (e) {
      setError(message(e));
    }
  };

  const rebuild = async () => {
    if (!selected || rebuilding) return;
    setRebuilding(true);
    setError(null);
    try {
      const updated = await admin.rebuildSopDocument(selected);
      setDocuments((prev) => prev.map((d) => (d.document_id === updated.document_id ? updated : d)));
      setSection(null);
      setSections(await admin.listSopSections(selected));
    } catch (e) {
      setError(message(e));
    } finally {
      setRebuilding(false);
    }
  };

  return {
    documents,
    error,
    selected,
    sections,
    section,
    rebuilding,
    loadDocuments,
    openDocument,
    openSection,
    rebuild,
  };
}

export type SopTabState = ReturnType<typeof useSopTab>;
