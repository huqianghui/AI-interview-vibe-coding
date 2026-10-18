/**
 * The interviewer to introduce on the screens shown before an interview exists.
 *
 * The persona is pinned only when `startInterview()` creates the session, so sign-in and idle used
 * to show the roster's hardcoded default — Sakura — even after an admin had picked Lisa, while the
 * orientation screen right after Start showed Lisa. Signed out, only the deployment's default
 * persona is knowable; signed in, the candidate's own assignment is, resolved as a start would.
 *
 * `pending` stays true until a real answer arrives, so the screen leaves the portrait blank rather
 * than show someone who may be the wrong person: a failed lookup keeps it blank too. A lost
 * candidate login (the lookup mints the session, which can refuse it) goes to `onAuthLost` so the
 * page can return to the sign-in card instead of sitting signed-in with no tokens.
 *
 * Scoped to the screen through {@link InterviewerLookup}: each visit to sign-in or idle mounts it
 * afresh, so coming back to idle after a restart asks again, and one visitor's answer never
 * outlives their screen.
 */
import { useEffect, useRef, useState } from "react";
import { CandidateAuthError, getDefaultInterviewer, getMyInterviewer } from "../api/client";

export interface InterviewerLookupResult {
  character: string;
  pending: boolean;
}

export function useInterviewerCharacter(
  signedIn: boolean,
  onAuthLost?: (e: CandidateAuthError) => void,
): InterviewerLookupResult {
  const [state, setState] = useState<{ key: boolean; character: string } | null>(null);
  const onAuthLostRef = useRef(onAuthLost);
  useEffect(() => {
    onAuthLostRef.current = onAuthLost;
  });

  useEffect(() => {
    let active = true;
    (signedIn ? getMyInterviewer() : getDefaultInterviewer()).then(
      (r) => {
        if (active) setState({ key: signedIn, character: r.character });
      },
      (e: unknown) => {
        if (active && e instanceof CandidateAuthError) onAuthLostRef.current?.(e);
      },
    );
    return () => {
      active = false;
    };
  }, [signedIn]);

  // An answer for the other sign-in state is stale (sign-in just flipped): wait for the new one.
  const settled = state !== null && state.key === signedIn;
  return { character: settled ? state.character : "", pending: !settled };
}
