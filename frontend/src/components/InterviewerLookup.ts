/**
 * Runs {@link useInterviewerCharacter} for exactly as long as the screen that shows the answer is
 * mounted. Rendered inside the sign-in and idle branches, so each visit looks the interviewer up
 * afresh and nothing carries over between visits or visitors.
 */
import type { ReactNode } from "react";
import type { CandidateAuthError } from "../api/client";
import {
  useInterviewerCharacter,
  type InterviewerLookupResult,
} from "../hooks/useInterviewerCharacter";

export function InterviewerLookup({
  signedIn,
  onAuthLost,
  children,
}: {
  signedIn: boolean;
  onAuthLost?: (e: CandidateAuthError) => void;
  children: (interviewer: InterviewerLookupResult) => ReactNode;
}) {
  return children(useInterviewerCharacter(signedIn, onAuthLost));
}
