import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import * as client from "../api/client";
import { useInterviewerCharacter } from "./useInterviewerCharacter";

afterEach(() => vi.restoreAllMocks());

describe("useInterviewerCharacter", () => {
  it("signed out: the default persona, pending until it arrives", async () => {
    vi.spyOn(client, "getDefaultInterviewer").mockResolvedValue({ character: "lisa" });
    const mine = vi.spyOn(client, "getMyInterviewer");
    const { result } = renderHook(() => useInterviewerCharacter(false));
    expect(result.current.pending).toBe(true);
    await waitFor(() => expect(result.current).toEqual({ character: "lisa", pending: false }));
    expect(mine).not.toHaveBeenCalled();
  });

  it("signed in: the candidate's own, and pending again across the flip", async () => {
    vi.spyOn(client, "getDefaultInterviewer").mockResolvedValue({ character: "sakura" });
    vi.spyOn(client, "getMyInterviewer").mockResolvedValue({ character: "lisa" });
    const { result, rerender } = renderHook(({ s }) => useInterviewerCharacter(s), {
      initialProps: { s: false },
    });
    await waitFor(() => expect(result.current.character).toBe("sakura"));
    rerender({ s: true });
    expect(result.current.pending).toBe(true);
    await waitFor(() => expect(result.current).toEqual({ character: "lisa", pending: false }));
  });

  it("a lost candidate login is handed to onAuthLost, and nobody is shown", async () => {
    const lost = new client.CandidateAuthError("expired", 401);
    vi.spyOn(client, "getMyInterviewer").mockRejectedValue(lost);
    const onAuthLost = vi.fn();
    const { result } = renderHook(() => useInterviewerCharacter(true, onAuthLost));
    await waitFor(() => expect(onAuthLost).toHaveBeenCalledWith(lost));
    expect(result.current.pending).toBe(true);
  });

  it("drops an answer for the sign-in state it no longer is in", async () => {
    // The signed-out answer arriving AFTER sign-in must not stand in for the candidate's own.
    let resolveDefault!: (v: { character: string }) => void;
    vi.spyOn(client, "getDefaultInterviewer").mockReturnValue(
      new Promise((r) => {
        resolveDefault = r;
      }),
    );
    let resolveMine!: (v: { character: string }) => void;
    vi.spyOn(client, "getMyInterviewer").mockReturnValue(
      new Promise((r) => {
        resolveMine = r;
      }),
    );
    const { result, rerender } = renderHook(({ s }) => useInterviewerCharacter(s), {
      initialProps: { s: false },
    });
    rerender({ s: true });
    await act(async () => resolveDefault({ character: "sakura" }));
    expect(result.current).toEqual({ character: "", pending: true });
    await act(async () => resolveMine({ character: "lisa" }));
    expect(result.current).toEqual({ character: "lisa", pending: false });
  });

  it("a failed lookup stays blank rather than guess the roster default", async () => {
    // Settling on "" would render Sakura: the wrong-person portrait this hook exists to prevent.
    const lookup = vi.spyOn(client, "getDefaultInterviewer").mockRejectedValue(new Error("down"));
    const onAuthLost = vi.fn();
    const { result } = renderHook(() => useInterviewerCharacter(false, onAuthLost));
    await waitFor(() => expect(lookup).toHaveBeenCalled());
    await act(async () => {});
    expect(result.current).toEqual({ character: "", pending: true });
    expect(onAuthLost).not.toHaveBeenCalled();
  });
});
