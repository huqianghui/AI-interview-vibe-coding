/** An interview's recorded spoken answers, one per question, for an admin to listen to. The
 * microphone only; each recording is deleted after the retention period (recording_service). */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Body1, Button, Text, Title3 } from "@fluentui/react-components";
import * as admin from "../../api/admin";
import type { InterviewRecording } from "../../api/admin";

function clock(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function InterviewRecordings({ interviewId }: { interviewId: string }) {
  const { t } = useTranslation();
  const [recordings, setRecordings] = useState<InterviewRecording[] | null>(null);
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null);
  const [problem, setProblem] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    setRecordings(null);
    admin
      .listInterviewRecordings(interviewId)
      .then((rows) => live && setRecordings(rows))
      .catch(() => live && setRecordings([]));
    return () => {
      live = false;
    };
  }, [interviewId]);

  // Release the object URL when it is replaced or the panel goes away.
  useEffect(() => () => (playing ? URL.revokeObjectURL(playing.url) : undefined), [playing]);

  const play = async (recordingId: string) => {
    try {
      const url = await admin.fetchInterviewRecording(interviewId, recordingId);
      setPlaying({ id: recordingId, url });
    } catch (e) {
      const status = (e as { status?: number }).status;
      setProblem((p) => ({
        ...p,
        [recordingId]: status === 410 ? t("admin.recordings.expired") : t("admin.recordings.failed"),
      }));
    }
  };

  if (recordings === null || recordings.length === 0) return null;
  return (
    <section data-testid="interview-recordings" style={{ marginTop: 16 }}>
      <Title3>{t("admin.recordings.title")}</Title3>
      <Text size={200} block>
        {t("admin.recordings.hint")}
      </Text>
      <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
        {recordings.map((r) => (
          <li key={r.recording_id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "4px 0" }}>
            <Text>
              {t("admin.recordings.question", { n: r.question_index + 1 })} · {clock(r.duration_ms)}
            </Text>
            {playing?.id === r.recording_id ? (
              <audio controls autoPlay src={playing.url} data-testid={`recording-audio-${r.recording_id}`} />
            ) : (
              <Button size="small" data-testid={`recording-play-${r.recording_id}`} onClick={() => void play(r.recording_id)}>
                {t("admin.recordings.play")}
              </Button>
            )}
            {problem[r.recording_id] && <Body1>{problem[r.recording_id]}</Body1>}
          </li>
        ))}
      </ul>
    </section>
  );
}
