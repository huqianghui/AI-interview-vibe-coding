/** State of the admin page's SOP tab: every SOP document, the selected one's key-points summary
 * and sections, and the selected section's full text (spec-sop-section-grounding). Loaded each time
 * the tab opens. Conversion and summary drafting run in the background, so while any document is
 * busy the list is polled, and the selected document reloads when its work finishes. */
import { useCallback, useEffect, useRef, useState } from "react";
import * as admin from "../../api/admin";
import type { SopDocument, SopLibrary, SopSummary, SopUnit, SopUnitText } from "../../api/admin";

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
  // The selected document's units (sections merged or opened to 500-4000 characters) and the open
  // one's passage: the same set the AI searches and cites (owner, 2026-10-09).
  const [sections, setSections] = useState<SopUnit[]>([]);
  const [section, setSection] = useState<SopUnitText | null>(null);
  const [summary, setSummary] = useState<SopSummary | null>(null);
  // The admin's edit in the summary box; reset whenever a summary is (re)loaded.
  const [summaryText, setSummaryText] = useState("");
  const [savingSummary, setSavingSummary] = useState(false);
  // The document the latest click asked for: a slower answer for an earlier click is dropped.
  const wanted = useRef<string | null>(null);

  const loadSections = useCallback(async (documentId: string) => {
    try {
      const rows = await admin.listSopUnits(documentId);
      if (wanted.current === documentId) setSections(rows);
    } catch (e) {
      if (wanted.current === documentId) {
        setSections([]);
        setError(message(e));
      }
    }
  }, []);

  // The summary text last loaded from the server: the box differs from it = unsaved edits.
  const loadedText = useRef("");
  const showSummary = useCallback((loaded: SopSummary, keepEdits = false) => {
    setSummary(loaded);
    // A background reload (a conversion finished) never throws away what the admin is typing.
    // `before` is read now: React may run the updater after the ref below has moved on.
    const before = loadedText.current;
    setSummaryText((typed) => (keepEdits && typed !== before ? typed : loaded.summary));
    loadedText.current = loaded.summary;
  }, []);

  const loadSummary = useCallback(
    async (documentId: string, keepEdits = false) => {
      try {
        const loaded = await admin.getSopSummary(documentId);
        if (wanted.current === documentId) showSummary(loaded, keepEdits);
      } catch (e) {
        if (wanted.current === documentId) setError(message(e));
      }
    },
    [showSummary],
  );

  // Libraries (spec-sop-libraries): listed collapsed; a click opens one to show its documents.
  const [libraries, setLibraries] = useState<SopLibrary[]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [uploading, setUploading] = useState<string | null>(null);
  // The one line above the libraries: what the last upload did (how many went in, which failed).
  const [notice, setNotice] = useState<{ uploaded: number; failed: string[] } | null>(null);

  // `quiet`: the background poll, which must not wipe an error the admin has not read yet.
  const loadDocuments = useCallback(async (quiet = false) => {
    if (!quiet) setError(null);
    try {
      const [docs, libs] = await Promise.all([admin.listSopDocuments(), admin.listSopLibraries()]);
      setDocuments(docs);
      setLibraries(libs);
    } catch (e) {
      setError(message(e));
    }
  }, []);

  const toggleLibrary = (libraryId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(libraryId)) next.delete(libraryId);
      else next.add(libraryId);
      return next;
    });

  const run = async (action: () => Promise<void>) => {
    setError(null);
    setNotice(null);
    try {
      await action();
      await loadDocuments();
    } catch (e) {
      setError(message(e));
    }
  };

  const createLibrary = (name: string) =>
    run(async () => {
      const made = await admin.createSopLibrary(name.trim());
      setExpanded((prev) => new Set(prev).add(made.library_id));
    });

  const renameLibrary = (libraryId: string, name: string) =>
    run(async () => {
      await admin.updateSopLibrary(libraryId, { name: name.trim() });
    });

  /** Delete an SOP nothing cites, after the admin confirms; the server refuses a cited one. */
  const deleteDocument = (doc: SopDocument, confirmText: string) => {
    if (typeof window !== "undefined" && !window.confirm(confirmText)) return Promise.resolve();
    return run(async () => {
      await admin.deleteSopDocument(doc.document_id);
      if (selected === doc.document_id) {
        wanted.current = null;
        setSelected(null);
      }
    });
  };

  const deleteLibrary = (libraryId: string) =>
    run(async () => {
      await admin.deleteSopLibrary(libraryId);
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(libraryId);
        return next;
      });
    });

  /** Upload files into a library, one after another; the conversion then runs in the background.
   * A file that fails does not stop the rest: the notice names each one and why. */
  const upload = async (libraryId: string, files: File[]) => {
    if (files.length === 0 || uploading) return;
    setUploading(libraryId);
    setError(null);
    let uploaded = 0;
    const failed: string[] = [];
    for (const file of files) {
      try {
        await admin.uploadSopDocument(libraryId, file);
        uploaded += 1;
      } catch (e) {
        failed.push(`${file.name}: ${message(e)}`);
      }
    }
    setNotice({ uploaded, failed });
    await loadDocuments();
    setUploading(null);
  };

  useEffect(() => {
    if (active) void loadDocuments();
  }, [active, loadDocuments]);

  const anyInProgress = documents.some(inProgress);
  useEffect(() => {
    if (!active || !anyInProgress) return;
    const timer = setInterval(() => void loadDocuments(true), SOP_POLL_MS);
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
      void loadSummary(selected, true);
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
    loadedText.current = "";
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

  const openSection = async (index: number) => {
    const documentId = selected;
    if (!documentId) return;
    try {
      const text = await admin.getSopUnit(documentId, index);
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
    libraries,
    expanded,
    toggleLibrary,
    createLibrary,
    renameLibrary,
    deleteLibrary,
    deleteDocument,
    upload,
    uploading,
    notice,
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
