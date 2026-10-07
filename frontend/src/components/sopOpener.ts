/**
 * How a report's SOP citation is fetched (a blob URL the link opens). The live report uses the
 * candidate route; a report opened from the history (#187) is read through the candidate's
 * history route or, for the admin, the admin route, so each wraps the report in a provider.
 */
import { createContext } from "react";
import { fetchSopDocument } from "../api/client";

export const SopOpenerContext =
  createContext<(interviewId: string, documentId: string) => Promise<string>>(fetchSopDocument);
