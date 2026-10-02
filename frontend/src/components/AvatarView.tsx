/**
 * AvatarView (SPEC F5/F9) — the interviewer's visual presence.
 *
 * Layers, in order:
 * 1. A `<video>` element (always in the DOM so `ontrack` can attach a stream at any time) — shown
 *    once a real digital-human avatar video track arrives from Voice Live.
 * 2. A cached still portrait of the interviewer (issue 5) — shown while the live stream is still
 *    connecting, so the PERSON appears instantly on every visit after the first. The portrait is a
 *    frame captured from the previous live session (localStorage), overlaid with the "connecting"
 *    hint; the live video fades in over it when frames arrive.
 * 3. The AudioOrb — shown when there's no avatar video AND no cached portrait yet (first-ever
 *    visit, voice-only session, or the persona has no character). So the page always has a
 *    presence.
 *
 * The `<video>` visibility is driven by opacity/z-index (not display:none) so the browser's
 * autoplay pipeline stays alive while a track is attaching.
 *
 * The `<video>` is **muted** on purpose: Chrome's autoplay policy blocks `play()` on an unmuted
 * media element outside a user gesture, and the avatar track is attached from the async `ontrack`
 * handler — an unmuted video silently fails to play and leaves a blank box. Muting the video is
 * safe because the avatar's AUDIO arrives on a SEPARATE `<audio>` element (see useInterviewVoice
 * ontrack), not this element.
 */
import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { makeStyles, mergeClasses, Text } from "@fluentui/react-components";
import { useTranslation } from "react-i18next";
import type { MediaMode } from "../hooks/avatarHealth";
import { AudioOrb } from "./AudioOrb";
import { fitBox, fitFor, hugRatioFor } from "./avatarFit";
import {
  BLANK_SAMPLE_HEIGHT,
  BLANK_SAMPLE_INTERVAL_MS,
  BLANK_SAMPLE_WIDTH,
  isBlankFrame,
  isPictureDead,
  meanLuma,
  nextBlankStreak,
} from "./avatarFrameHealth";
import type { AudioState } from "../types/voice";

/** Single-slot portrait cache. This deployment runs ONE default interviewer persona, so the slot
 * isn't keyed by character; a persona/avatar change self-corrects on the next successful session
 * (the capture below overwrites the slot). Bump the suffix if the stored format ever changes.
 *
 * v1 → v2 (2026-10-02): the MEANING changed, not the format. Portraits captured before the page
 * started sending `avatar_bg` for every avatar type carry whatever studio wall Azure happened to
 * use, so a stale slot shows the figure on a colour that no longer matches the page — and it is
 * shown FIRST on every visit, before the live stream arrives, which is exactly when a mismatched
 * rectangle is most visible. Bumping the key discards those instead of waiting for a successful
 * session to overwrite them. */
export const AVATAR_PORTRAIT_STORAGE_KEY = "avatar-portrait-v2";
/** Give the stream a beat after the first frames so the captured pose is settled, not mid-fade. */
const PORTRAIT_CAPTURE_DELAY_MS = 2000;
/** Downscale the 1080p frame for storage — a stage-quality still at a fraction of the quota. */
const PORTRAIT_CAPTURE_WIDTH = 480;

const useStyles = makeStyles({
  root: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    // Fills the stage until the media's aspect is known; then `hugBox` sizes it to the largest box
    // of EXACTLY the stream's aspect that fits the parent (see `useHugBox`), so there is no
    // letterbox band and no frame around the digital human — the media is the whole surface.
    width: "100%",
    height: "100%",
    minHeight: 0,
    borderRadius: "12px",
    overflow: "hidden",
  },
  video: {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    // The fit is chosen PER STREAM (see `fitFor`): `fitCover` for 16:9 video avatars, `fitContain`
    // for square/portrait photo avatars. Default (before metadata) is contain — never crop blind.
    borderRadius: "12px",
    transition: "opacity 300ms ease",
  },
  // 16:9 VIDEO avatars (lisa, …): fill the stage; the frame is a centred person on wide white
  // margins, so `cover` crops those margins, never the figure — anchored top so the head is the
  // last thing sacrificed.
  fitCover: { objectFit: "cover", objectPosition: "center top" },
  // Square / portrait PHOTO avatars (vasa-1: amira, adrian, …) stream 512×512 (live-verified). On
  // the interview page's wider-than-square stage `cover` scaled by width and cut the shoulders and
  // chin off the bottom (issue1, 2026-09-24), so these keep the WHOLE frame — the same head-and-
  // shoulders framing the editor's photo preview shows.
  fitContain: { objectFit: "contain", objectPosition: "center center" },
  hidden: { opacity: 0, zIndex: 0, pointerEvents: "none" },
  shown: { opacity: 1, zIndex: 10 },
  // The still portrait sits UNDER the video layer (z-index 5 < shown 10) so the live stream fades
  // in over it with no orb flash in between.
  portrait: {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    borderRadius: "12px",
    zIndex: 5,
    // Slightly dimmed so "not live yet" is perceptible without hiding the person.
    filter: "saturate(0.85) brightness(0.92)",
  },
  connectingHint: {
    position: "absolute",
    bottom: "16px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 6,
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 14px",
    borderRadius: "16px",
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    color: "#fff",
    // The zh-CN voice-only copy is much longer than the "connecting" string this pill was tuned for,
    // and the pill is centred with translateX(-50%) against no edge constraint — so cap it and let it
    // wrap rather than overflow the stage on a phone-width viewport.
    maxWidth: "calc(100% - 24px)",
    textAlign: "center",
  },
  voiceOnlyDot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    // Amber and steady: this is a settled state, not something still in progress, so it must not
    // pulse like the connecting dot.
    backgroundColor: "#f0b429",
  },
  connectingDot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    backgroundColor: "#7ee787",
    animationName: {
      "0%": { opacity: 0.3 },
      "50%": { opacity: 1 },
      "100%": { opacity: 0.3 },
    },
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
  },
});

/** Observe the element's PARENT size and return the hug box for the given media aspect (null until
 * both are known, or when ResizeObserver is unavailable — then the root just fills the parent). */
function useHugBox(el: HTMLElement | null, ratio: number | null) {
  const [parent, setParent] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const target = el?.parentElement;
    if (!target || typeof ResizeObserver === "undefined") return;
    const measure = () => setParent({ w: target.clientWidth, h: target.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(target);
    return () => ro.disconnect();
  }, [el]);
  return parent && ratio ? fitBox(parent.w, parent.h, ratio) : null;
}

function readCachedPortrait(): string | null {
  try {
    const v = localStorage.getItem(AVATAR_PORTRAIT_STORAGE_KEY);
    return v && v.startsWith("data:image/") ? v : null;
  } catch {
    return null; // storage unavailable (privacy mode) → orb fallback, as before
  }
}

interface AvatarViewProps {
  audioState: AudioState;
  /** True once a real avatar video track is playing → show video, hide the orb. */
  isAvatarConnected: boolean;
  /** `"audio-only"` once the media layer gave up the picture to protect the interviewer's voice on a
   * weak link (`docs/avatar-weaknet-probe.md` §3.9). Without this the orb is ambiguous — it looks
   * identical to "still connecting", so the candidate can't tell a deliberate degrade from a hang.
   * Defaults to `"video"` so callers that don't care (the editor Playground) need no change. */
  mediaMode?: MediaMode;
}

/** Ref is the `<video>` element the voice hook attaches the avatar stream to (via `videoRef`). */
export const AvatarView = forwardRef<HTMLVideoElement, AvatarViewProps>(function AvatarView(
  { audioState, isAvatarConnected, mediaMode = "video" },
  ref,
) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [portrait, setPortrait] = useState<string | null>(readCachedPortrait);
  const innerRef = useRef<HTMLVideoElement | null>(null);
  // Per-stream fit, read from the element's intrinsic size (the voice hook assigns the element's
  // own on* handlers, so listen with addEventListener to coexist). Contain until metadata arrives.
  const [videoFit, setVideoFit] = useState<"cover" | "contain">("contain");
  const [portraitFit, setPortraitFit] = useState<"cover" | "contain">("contain");
  // Media aspect (w/h) of whatever is showing — the live stream once it has frames, else the cached
  // still — drives the hug box below so the root is exactly the media's shape.
  const [videoRatio, setVideoRatio] = useState<number | null>(null);
  const [portraitRatio, setPortraitRatio] = useState<number | null>(null);
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const video = innerRef.current;
    if (!video) return;
    const reflect = () => {
      setVideoFit(fitFor(video.videoWidth, video.videoHeight));
      setVideoRatio(video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : null);
    };
    reflect();
    video.addEventListener("loadedmetadata", reflect);
    video.addEventListener("resize", reflect);
    return () => {
      video.removeEventListener("loadedmetadata", reflect);
      video.removeEventListener("resize", reflect);
    };
  }, []);

  // Merge the forwarded ref (the voice hook's stream target) with a local one (frame capture).
  const setVideoRef = useCallback(
    (el: HTMLVideoElement | null) => {
      innerRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  // The picture is arriving but EMPTY. Separate from `isAvatarConnected` on purpose: that flag means
  // frames exist, which a black stream also satisfies. See avatarFrameHealth for why this is a
  // readable/blank streak rather than a brightness judgement.
  const [pictureDead, setPictureDead] = useState(false);
  const blankStreakRef = useRef(0);

  /** Draw the current frame small and read its mean luminance. `readable: false` when there was no
   * frame to read — which is NOT the same as a blank one. */
  const sampleLuma = useCallback((): { readable: boolean; luma: number } => {
    const video = innerRef.current;
    // HAVE_CURRENT_DATA; below this there is no frame yet and a canvas read returns transparent black.
    if (!video || video.readyState < 2 || video.videoWidth === 0) return { readable: false, luma: 0 };
    try {
      const canvas = document.createElement("canvas");
      canvas.width = BLANK_SAMPLE_WIDTH;
      canvas.height = BLANK_SAMPLE_HEIGHT;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return { readable: false, luma: 0 };
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return { readable: true, luma: meanLuma(data) };
    } catch {
      // A tainted or unavailable canvas is a read failure, not a verdict.
      return { readable: false, luma: 0 };
    }
  }, []);

  // Watch for the picture going empty while we are still claiming it works. When it does, the stage
  // falls back to the cached still or the orb — the three-state contract (owner, 2026-10-02: "it is
  // either the cached frame, the digital human, or the audio orb; a black screen is not our design").
  useEffect(() => {
    if (!isAvatarConnected || mediaMode === "audio-only") {
      blankStreakRef.current = 0;
      setPictureDead(false);
      return;
    }
    const tick = () => {
      const { readable, luma } = sampleLuma();
      const streak = nextBlankStreak(blankStreakRef.current, readable, luma);
      blankStreakRef.current = streak;
      const dead = isPictureDead(streak);
      setPictureDead((was) => {
        if (dead && !was) {
          // EVIDENCE, not just a symptom. A screenshot of a black box cannot say whether the pixels
          // came from the media or from our own DOM, nor whether the remote end was still sending.
          // This records what the element and its track actually were at the moment of the verdict,
          // so the next occurrence is explainable. getStats-level detail (bytes, framesDecoded) is
          // sampled by useAvatarStream on the same connection.
          const video = innerRef.current;
          const track = (video?.srcObject as MediaStream | null)?.getVideoTracks?.()[0];
          console.warn(
            "[avatar] picture is EMPTY while frames are arriving — falling back to the still/orb",
            {
              meanLuma: Number(luma.toFixed(2)),
              blankSamples: streak,
              videoSize: video ? `${video.videoWidth}x${video.videoHeight}` : "none",
              videoReadyState: video?.readyState,
              trackId: track?.id,
              trackMuted: track?.muted,
              trackReadyState: track?.readyState,
              trackEnabled: track?.enabled,
            },
          );
        }
        return dead;
      });
    };
    tick();
    const timer = setInterval(tick, BLANK_SAMPLE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isAvatarConnected, mediaMode, sampleLuma]);

  // Refresh the portrait slot from the LIVE stream so the next visit shows the person instantly.
  // Best-effort: a failed capture (no frames yet, canvas unavailable, storage quota) just keeps
  // whatever the slot already holds. MediaStream frames never taint the canvas, so toDataURL is
  // safe here.
  useEffect(() => {
    if (!isAvatarConnected) return;
    const timer = setTimeout(() => {
      const video = innerRef.current;
      if (!video || video.videoWidth === 0) return;
      // Never cache an empty frame: the still is shown FIRST on the next visit, so storing a black one
      // would turn a transient fault into a permanent black screen for that candidate.
      const probe = sampleLuma();
      if (!probe.readable || isBlankFrame(probe.luma)) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = PORTRAIT_CAPTURE_WIDTH;
        canvas.height = Math.round((video.videoHeight / video.videoWidth) * PORTRAIT_CAPTURE_WIDTH);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.75);
        localStorage.setItem(AVATAR_PORTRAIT_STORAGE_KEY, dataUrl);
        setPortrait(dataUrl);
      } catch {
        /* best-effort — keep the previous portrait (or none) */
      }
    }, PORTRAIT_CAPTURE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isAvatarConnected, sampleLuma]);

  // Deliberately picture-less: say so, and don't also claim to be "connecting".
  const audioOnly = mediaMode === "audio-only";
  // An empty picture counts as NO picture everywhere below, so the stage can only ever be showing the
  // live figure, the cached still, or the orb.
  const showVideo = isAvatarConnected && !pictureDead;
  const showPortrait = !showVideo && !audioOnly && portrait !== null;
  const mediaRatio = showVideo ? videoRatio : showPortrait ? portraitRatio : null;
  // Which fit the showing media wants. A wide (>=1.4) stream is `cover`: the frame is a centred person
  // on wide empty margins, so filling the column and cropping those margins never touches the figure.
  // A square/portrait photo avatar is `contain`: cropping it cuts the shoulders and chin (issue1).
  const mediaFit = showVideo ? videoFit : showPortrait ? portraitFit : "contain";
  // HUG ONLY WHAT WE KEEP WHOLE. Sizing the box to the stream's exact aspect is what removes the
  // letterbox for a photo avatar — but for a 16:9 stream in this column it is also what left the
  // bottom 364px empty (measured on the live site: column 829px tall, box 826x465), so the stage
  // lined up with the question card at the top and nowhere near it at the bottom. A cover-fit stream
  // therefore fills the column instead and crops its own margins, which is what `fitFor` has always
  // said to do with it. Owner, 2026-10-02: "the top lines up, the bottom doesn't — is it the aspect
  // ratio?" It was.
  const hug = useHugBox(rootEl, hugRatioFor(mediaFit, mediaRatio));
  return (
    <div
      ref={setRootEl}
      className={styles.root}
      style={hug ? { width: hug.width, height: hug.height } : undefined}
      data-testid="avatar-view"
      data-avatar-connected={isAvatarConnected}
      data-picture-dead={pictureDead}
      data-media-mode={mediaMode}
    >
      <video
        ref={setVideoRef}
        autoPlay
        playsInline
        muted
        className={mergeClasses(
          styles.video,
          videoFit === "cover" ? styles.fitCover : styles.fitContain,
          showVideo ? styles.shown : styles.hidden,
        )}
        data-fit={videoFit}
        data-testid="avatar-video"
      />
      {showPortrait && (
        <>
          <img
            src={portrait}
            alt=""
            className={mergeClasses(
              styles.portrait,
              portraitFit === "cover" ? styles.fitCover : styles.fitContain,
            )}
            onLoad={(e) => {
              const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
              setPortraitFit(fitFor(w, h));
              setPortraitRatio(w > 0 && h > 0 ? w / h : null);
            }}
            data-fit={portraitFit}
            data-testid="avatar-portrait"
          />
          <div className={styles.connectingHint} data-testid="avatar-connecting-hint">
            <span className={styles.connectingDot} aria-hidden />
            <Text size={200}>{t("voice.connecting")}</Text>
          </div>
        </>
      )}
      {!showVideo && !showPortrait && <AudioOrb audioState={audioState} />}
      {audioOnly && (
        // role=status + aria-live so a screen-reader user is TOLD the picture was dropped. Losing the
        // digital human mid-interview is a bigger state change than anything the orb announces, so it
        // must not be the one thing that is silent to assistive tech.
        <div
          className={styles.connectingHint}
          role="status"
          aria-live="polite"
          data-testid="avatar-voice-only-hint"
        >
          <span className={styles.voiceOnlyDot} aria-hidden />
          <Text size={200}>{t("voice.voiceOnlyNotice")}</Text>
        </div>
      )}
    </div>
  );
});
