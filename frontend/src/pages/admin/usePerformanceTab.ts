/** State of the admin "Performance" tab (spec-admin-performance-tab): the network check from this
 * browser, the Operation id lookup, and what this deployment can link to. The page owns the hook,
 * so a lookup survives switching tabs, and Interview results can open it on an id. */
import { useCallback, useEffect, useRef, useState } from "react";
import * as admin from "../../api/admin";
import type { OperationLookup, PerformanceLinks, TransactionLink } from "../../api/admin";
import * as auth from "../../api/auth";
import { operationIdFor } from "../../telemetry/appInsights";
import {
  browserNetwork,
  measureApi,
  measureWs,
  type ApiRtt,
  type BrowserNetwork,
  type WsReach,
} from "./performanceProbe";

/** A pasted Operation id (or interview id) as 32 lowercase hex, or null. The backend's
 * `performance_service.normalize` is the same rule. */
export function normalizeOperationId(raw: string): string | null {
  return operationIdFor(raw.trim());
}

export interface NetworkResult {
  api: ApiRtt;
  ws: WsReach;
  browser: BrowserNetwork | null;
}

export type TransactionState =
  | { kind: "idle" }
  | { kind: "finding" }
  | { kind: "done"; link: TransactionLink }
  | { kind: "failed"; message: string };

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function usePerformanceTab(active: boolean) {
  const [links, setLinks] = useState<PerformanceLinks | null>(null);
  const [network, setNetwork] = useState<NetworkResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [input, setInput] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [looking, setLooking] = useState(false);
  const [result, setResult] = useState<OperationLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transaction, setTransaction] = useState<TransactionState>({ kind: "idle" });
  const lookupSeq = useRef(0);

  useEffect(() => {
    if (!active || links) return;
    admin.getPerformanceLinks().then(setLinks, () => undefined);
  }, [active, links]);

  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      const [api, ws] = await Promise.all([measureApi(), measureWs(auth.getAdminToken())]);
      setNetwork({ api, ws, browser: browserNetwork() });
    } finally {
      setChecking(false);
    }
  }, []);

  /** Look an id up (from the input, or from Interview results). */
  const lookup = useCallback(async (raw: string) => {
    setInput(raw);
    setError(null);
    setTransaction({ kind: "idle" });
    const id = normalizeOperationId(raw);
    setInvalid(id === null);
    // Bumped first, so a lookup still in flight cannot land after this one (valid or not).
    const seq = ++lookupSeq.current;
    if (id === null) {
      setResult(null);
      setLooking(false);
      return;
    }
    setLooking(true);
    try {
      const found = await admin.lookupOperation(id);
      if (seq === lookupSeq.current) setResult(found);
    } catch (e) {
      if (seq === lookupSeq.current) {
        setResult(null);
        setError(errorText(e));
      }
    } finally {
      if (seq === lookupSeq.current) setLooking(false);
    }
  }, []);

  const findTransaction = useCallback(async () => {
    const id = result?.operation_id;
    if (!id) return;
    setTransaction({ kind: "finding" });
    const seq = lookupSeq.current;
    // A new lookup since this started owns the card now: drop this answer.
    const current = () => seq === lookupSeq.current;
    try {
      const link = await admin.getTransactionLink(id);
      if (current()) setTransaction({ kind: "done", link });
    } catch (e) {
      if (current()) setTransaction({ kind: "failed", message: errorText(e) });
    }
  }, [result]);

  return {
    links,
    network,
    checking,
    runCheck,
    input,
    setInput,
    invalid,
    looking,
    result,
    error,
    lookup,
    transaction,
    findTransaction,
  };
}

export type PerformanceTabState = ReturnType<typeof usePerformanceTab>;
