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
import { forwardRef, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { makeStyles, mergeClasses, Text } from "@fluentui/react-components";
import { useTranslation } from "react-i18next";
import type { MediaMode } from "../hooks/avatarHealth";
import { AudioOrb } from "./AudioOrb";
import { fitBox, fitFor, hugRatioFor } from "./avatarFit";
import {
  BACKDROP_SAMPLE_SIZE,
  backdropMoved,
  edgeBackdrop,
  photoBox,
} from "./avatarBackdrop";
import { portraitKeyFor, readCachedPortrait } from "./avatarPortraitCache";
import { STRIP_GAP_PX, STRIP_MAX_PX } from "./BroadcastChrome";
import { palette } from "../theme";
import {
  BLANK_SAMPLE_HEIGHT,
  BLANK_SAMPLE_INTERVAL_MS,
  BLANK_STREAK_TO_FAIL,
  BLANK_SAMPLE_WIDTH,
  initialPictureState,
  isBlankFrame,
  meanLuma,
  nextPictureState,
  pictureIsShowable,
  type PictureState,
  type SampleStatus,
} from "./avatarFrameHealth";
import type { AudioState } from "../types/voice";

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

/** Framed layout: clearance above the window (its 7 px frame sits outside it), at its sides, and the
 * room left under it for the topic strip, at its tallest (chips on two rows). */
const FRAMED_TOP_PX = 14;
const FRAMED_SIDE_PX = 10;
const FRAMED_BELOW_PX = STRIP_GAP_PX + STRIP_MAX_PX;
/** Narrow screens stack the stage under the controls with a content-sized height, so sizing the
 * window from that height would feed back on itself: there it is sized from the width alone. */
const NARROW_QUERY = "(max-width: 900px)";
/** The "connecting" pill clears the name plate (56 px) on a framed window. */
const FRAMED_HINT_BOTTOM_PX = 72;

/** The framed window's edge: a light inner line, the ink frame, and a soft drop shadow. */
const FRAME_SHADOW =
  `0 0 0 3px ${palette.lilac}, 0 0 0 7px ${palette.ink}, ` + "0 14px 32px rgba(40, 20, 70, 0.28)";

function useMatches(query: string): boolean {
  const get = () => typeof window !== "undefined" && !!window.matchMedia?.(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    const mq = typeof window !== "undefined" ? window.matchMedia?.(query) : undefined;
    if (!mq) return;
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [query]);
  return matches;
}

/** A photo avatar streams this square (live-verified); the cached still is stored smaller, so it is
 * drawn at this size too and the live face fades in over it without a jump. */
const PHOTO_NATIVE_PX = 512;

/** Observe the element's PARENT size (null until known, or when ResizeObserver is unavailable). */
function useParentSize(el: HTMLElement | null) {
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
  return parent;
}

interface AvatarViewProps {
  audioState: AudioState;
  /** True once a real avatar video track is playing → show video, hide the orb. */
  isAvatarConnected: boolean;
  /** `"audio-only"` once the media layer gave up the picture to protect the interviewer's voice on a
   * weak link (`docs/avatar-weaknet-probe.md` §3.9); `"voice-only"` when there is no avatar session at
   * all (the self-heal's answer to a network that cannot carry it). Without this the
   * orb is ambiguous — it looks identical to "still connecting", so the candidate can't tell a
   * deliberate degrade from a hang. Defaults to `"video"` so callers that don't care need no change. */
  mediaMode?: MediaMode;
  /** Which avatar is configured, so the cached still belongs to the right face. Omit it and the slot
   * stays un-keyed — the pre-2026-10-03 behaviour, which is correct for a persona with no character. */
  character?: string | null;
  /** The wall colour Azure was asked to paint behind a photo avatar (`avatar_bg`). The stage is
   * painted this until the picture's own edge colour has been read, then that (see avatarBackdrop). */
  backdrop?: string | null;
  /** The interview page's broadcast layout (owner, 2026-10-17): a photo avatar is shown as a FRAMED
   * window of exactly its own size (never enlarged), with `photoOverlay` (the name plate) over its
   * bottom edge, instead of filling the stage. The page draws the backdrop and the topic strip. */
  framed?: boolean;
  /** Shown inside the framed window, over the bottom of the picture (where its frame ends). */
  photoOverlay?: ReactNode;
  /** Shown directly UNDER the framed window (the topic strip); the window leaves room for it. */
  photoBelow?: ReactNode;
  /** Drawn AROUND the framed window (crop marks, side notes): a layer exactly over the window's
   * box, so its children position themselves against the window's edges. Given the free width on
   * each side, so side notes can step aside on a narrow stage. */
  photoAround?: (geometry: { gutter: number }) => ReactNode;
  /** Room above the framed window (default: just its frame). A page that draws something over the
   * top of the stage (a masthead) asks for more. */
  framedTopPx?: number;
  /** Told whether a photo avatar's picture (live or its cached still) is what is showing, so the
   * page can show the broadcast layout around it, and the plain stage around the orb. */
  onPhotoStage?: (photo: boolean) => void;
}

/** Ref is the `<video>` element the voice hook attaches the avatar stream to (via `videoRef`). */
export const AvatarView = forwardRef<HTMLVideoElement, AvatarViewProps>(function AvatarView(
  {
    audioState,
    isAvatarConnected,
    mediaMode = "video",
    character = null,
    backdrop = null,
    framed = false,
    photoOverlay,
    photoBelow,
    photoAround,
    framedTopPx = FRAMED_TOP_PX,
    onPhotoStage,
  },
  ref,
) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [portrait, setPortrait] = useState<string | null>(() => readCachedPortrait(character));
  // Follow the character: the configured avatar can change between visits (and, in the editor, within
  // one). Without this the slot read at mount would outlive the switch and keep showing the old face.
  useEffect(() => {
    setPortrait(readCachedPortrait(character));
  }, [character]);
  const innerRef = useRef<HTMLVideoElement | null>(null);
  // Per-stream fit, read from the element's intrinsic size (the voice hook assigns the element's
  // own on* handlers, so listen with addEventListener to coexist). Contain until metadata arrives.
  const [videoFit, setVideoFit] = useState<"cover" | "contain">("contain");
  const [portraitFit, setPortraitFit] = useState<"cover" | "contain">("contain");
  // Media aspect (w/h) of whatever is showing — the live stream once it has frames, else the cached
  // still — drives the hug box below so the root is exactly the media's shape.
  const [videoRatio, setVideoRatio] = useState<number | null>(null);
  // The stream's own size, as state so a photo avatar's box follows a resolution change.
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const [portraitRatio, setPortraitRatio] = useState<number | null>(null);
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const video = innerRef.current;
    if (!video) return;
    const reflect = () => {
      setVideoFit(fitFor(video.videoWidth, video.videoHeight));
      setVideoRatio(video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : null);
      setVideoSize(
        video.videoWidth > 0 && video.videoHeight > 0
          ? { width: video.videoWidth, height: video.videoHeight }
          : null,
      );
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
  const [picture, setPicture] = useState<PictureState>(initialPictureState);
  const pictureRef = useRef<PictureState>(initialPictureState);

  /** Draw the current frame small and read its mean luminance, saying WHY when it cannot. */
  const sampleLuma = useCallback((): { status: SampleStatus; luma: number } => {
    const video = innerRef.current;
    // HAVE_CURRENT_DATA; below this there is simply no frame yet — not a blank one, and not a browser
    // that cannot sample. Keep waiting.
    if (!video || video.readyState < 2 || video.videoWidth === 0) return { status: "not-ready", luma: 0 };
    try {
      const canvas = document.createElement("canvas");
      canvas.width = BLANK_SAMPLE_WIDTH;
      canvas.height = BLANK_SAMPLE_HEIGHT;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return { status: "unsupported", luma: 0 };
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return { status: "ok", luma: meanLuma(data) };
    } catch {
      // A tainted or unavailable canvas means this browser will never tell us; it is not a verdict.
      return { status: "unsupported", luma: 0 };
    }
  }, []);

  // The wall colour as the browser actually draws it: read from the frame's edges (avatarBackdrop).
  const [sampledBackdrop, setSampledBackdrop] = useState<string | null>(null);
  const sampledRef = useRef<string | null>(null);
  const readBackdrop = useCallback((source: CanvasImageSource) => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = BACKDROP_SAMPLE_SIZE;
      canvas.height = BACKDROP_SAMPLE_SIZE;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const color = edgeBackdrop(data, canvas.width, canvas.height);
      if (color && backdropMoved(sampledRef.current, color)) {
        sampledRef.current = color;
        setSampledBackdrop(color);
      }
    } catch {
      /* this browser cannot read the frame: the requested colour stays */
    }
  }, []);
  // A different face (or no face) has a different wall: start again from the requested colour.
  useEffect(() => {
    sampledRef.current = null;
    setSampledBackdrop(null);
  }, [character, backdrop]);

  // Watch for the picture going empty while we are still claiming it works. When it does, the stage
  // falls back to the cached still or the orb — the three-state contract (owner, 2026-10-02: "it is
  // either the cached frame, the digital human, or the audio orb; a black screen is not our design").
  useEffect(() => {
    if (!isAvatarConnected || mediaMode === "audio-only") {
      pictureRef.current = initialPictureState;
      setPicture(initialPictureState);
      return;
    }
    const tick = () => {
      const { status, luma } = sampleLuma();
      // A photo avatar's stage follows its picture's wall; read it while the picture has content.
      const video = innerRef.current;
      // Framed, the window shows its own wall and nothing is painted from it: skip the readback.
      const square = !!video && fitFor(video.videoWidth, video.videoHeight) === "contain";
      if (!framed && status === "ok" && !isBlankFrame(luma) && video && square) {
        readBackdrop(video);
      }
      const prev = pictureRef.current;
      const next = nextPictureState(prev, status, luma);
      pictureRef.current = next;
      if (next.verdict !== prev.verdict) setPicture(next);
      // Log on the blank RUN, not on the demotion. A picture that is black from the first frame never
      // reaches `blank` — it stays `waiting` and is simply never shown, which is the fix working — and
      // that is precisely the case measured on real Azure, so it is the case that most needs evidence.
      if (next.blankStreak === BLANK_STREAK_TO_FAIL) {
        {
          // EVIDENCE, not just a symptom. A screenshot of a black box cannot say whether the pixels came
          // from the media or from our own DOM, nor whether the remote end was still sending. This
          // records what the element and its track actually were at the moment of the verdict, so the
          // next occurrence is explainable. getStats-level detail (bytes, framesDecoded) is sampled by
          // useAvatarStream on the same connection.
          const video = innerRef.current;
          const track = (video?.srcObject as MediaStream | null)?.getVideoTracks?.()[0];
          console.warn(
            "[avatar] picture is EMPTY while frames are arriving — falling back to the still/orb",
            {
              meanLuma: Number(luma.toFixed(2)),
              blankSamples: next.blankStreak,
              videoSize: video ? `${video.videoWidth}x${video.videoHeight}` : "none",
              videoReadyState: video?.readyState,
              trackId: track?.id,
              trackMuted: track?.muted,
              trackReadyState: track?.readyState,
              trackEnabled: track?.enabled,
            },
          );
        }
      }
      if (next.verdict === "content" && prev.verdict === "waiting" && status === "unsupported") {
        // Shown without proof because this browser cannot give us pixels. Worth a line: it means the
        // blank-frame guard is inert here, so a black stream would go unnoticed.
        console.debug("[avatar] cannot sample frames — showing the picture unverified", {
          reason: "canvas cannot read video frames in this browser",
        });
      }
    };
    tick();
    const timer = setInterval(tick, BLANK_SAMPLE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isAvatarConnected, mediaMode, sampleLuma, readBackdrop, framed]);

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
      if (probe.status !== "ok" || isBlankFrame(probe.luma)) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = PORTRAIT_CAPTURE_WIDTH;
        canvas.height = Math.round((video.videoHeight / video.videoWidth) * PORTRAIT_CAPTURE_WIDTH);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.75);
        localStorage.setItem(portraitKeyFor(character), dataUrl);
        setPortrait(dataUrl);
      } catch {
        /* best-effort — keep the previous portrait (or none) */
      }
    }, PORTRAIT_CAPTURE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isAvatarConnected, sampleLuma, character]);

  // Deliberately picture-less: say so, and don't also claim to be "connecting".
  const audioOnly = mediaMode !== "video";
  const noticeKey = mediaMode === "audio-only" ? "voice.voiceOnlyNotice" : "voice.voiceOnlyNetworkNotice";
  // An empty picture counts as NO picture everywhere below, so the stage can only ever be showing the
  // live figure, the cached still, or the orb.
  // PROOF, not mere arrival: frames existing is not evidence that they contain anything.
  const showVideo = isAvatarConnected && pictureIsShowable(picture);
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
  const parent = useParentSize(rootEl);
  // A PHOTO avatar (owner, 2026-10-17): drawn at its own 512 px, never enlarged (enlarging is what
  // softened the face), and the whole stage around it painted the picture's own wall colour so
  // there is no colour step and nothing that reads as a frame. Anchored bottom-centre: the frame
  // ends at the shoulders, which must meet the stage's bottom edge rather than stop in mid-air.
  // A video avatar keeps its hug/cover behaviour unchanged.
  const photoStage = (showVideo || showPortrait) && mediaFit === "contain" && !!mediaRatio;
  // The live stream's own size; the still (stored smaller) is drawn at the size the stream has.
  const nativeVideo =
    showVideo && videoSize
      ? videoSize
      : { width: PHOTO_NATIVE_PX, height: Math.round(PHOTO_NATIVE_PX / (mediaRatio || 1)) };
  // Framed, the window keeps clear of the stage's edges (its frame is drawn outside it) and leaves
  // room underneath for the topic strip, so on a short screen it shrinks rather than push the
  // strip out of sight; it is never enlarged.
  const narrow = useMatches(NARROW_QUERY);
  const photo =
    photoStage && parent
      ? framed
        ? photoBox(
            parent.w - 2 * FRAMED_SIDE_PX,
            narrow ? Number.POSITIVE_INFINITY : parent.h - framedTopPx - FRAMED_BELOW_PX,
            nativeVideo,
          )
        : photoBox(parent.w, parent.h, nativeVideo)
      : null;
  const ratio = hugRatioFor(mediaFit, mediaRatio);
  // Framed: the window IS the picture, at its own size; nothing is filled around it here (the page
  // draws the set). Unframed (the editor): the v0.77.2.0 stage, filled with the read-back wall.
  // Only once the window's size is known: before that (stage not measured yet) the frame, plate
  // and strip would wrap a box that fills the stage, and jump when it is measured.
  const framedPhoto = framed && photoStage && photo !== null;
  const hug = framedPhoto
    ? photo
    : !photoStage && parent && ratio
      ? fitBox(parent.w, parent.h, ratio)
      : null;
  const stageFill = photoStage && !framed ? (sampledBackdrop ?? backdrop ?? undefined) : undefined;
  useEffect(() => {
    onPhotoStage?.(framedPhoto);
  }, [framedPhoto, onPhotoStage]);
  const photoMedia = photo && !framed
    ? {
        inset: "auto",
        bottom: 0,
        left: "50%",
        transform: "translateX(-50%)",
        width: photo.width,
        height: photo.height,
        borderRadius: 0,
        // The still is normally dimmed while connecting; on a painted stage that dimming would show
        // as a darker square. The "connecting" pill already says it is not live yet.
        filter: "none",
      }
    : undefined;
  return (
    <>
      <div
        ref={setRootEl}
        className={styles.root}
        style={
          hug
            ? {
                width: hug.width,
                height: hug.height,
                // The broadcast window's frame: drawn as a shadow so it takes no layout space and the
                // picture keeps exactly its own size inside it.
                ...(framedPhoto
                  ? { boxShadow: FRAME_SHADOW, flexShrink: 0, marginTop: framedTopPx }
                  : {}),
              }
            : stageFill
              ? { backgroundColor: stageFill }
              : undefined
        }
        data-testid="avatar-view"
        data-avatar-connected={isAvatarConnected}
        data-picture={picture.verdict}
        data-media-mode={mediaMode}
        data-photo-stage={photoStage}
        data-framed={framedPhoto}
        data-backdrop={stageFill ?? ""}
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
          style={showVideo ? photoMedia : undefined}
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
              style={photoMedia}
              onLoad={(e) => {
                const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
                setPortraitFit(fitFor(w, h));
                setPortraitRatio(w > 0 && h > 0 ? w / h : null);
                // The still is a frame of the same stream: its edges give the wall before it is live.
                if (fitFor(w, h) === "contain") readBackdrop(e.currentTarget);
              }}
              data-fit={portraitFit}
              data-testid="avatar-portrait"
            />
            <div
            className={styles.connectingHint}
            style={framedPhoto ? { bottom: FRAMED_HINT_BOTTOM_PX } : undefined}
            data-testid="avatar-connecting-hint"
          >
              <span className={styles.connectingDot} aria-hidden />
              <Text size={200}>{t("voice.connecting")}</Text>
            </div>
          </>
        )}
        {!showVideo && !showPortrait && <AudioOrb audioState={audioState} />}
        {framedPhoto && photoOverlay}
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
            <Text size={200}>{t(noticeKey)}</Text>
          </div>
        )}
      </div>
      {framedPhoto && photoAround && photo && parent && (
        // Over the window's box (the parent is the positioned stage column; the window is centred
        // in it, `framedTopPx` from its top), never in the way of the picture or its controls.
        <div
          aria-hidden
          data-testid="avatar-photo-around"
          style={{
            position: "absolute",
            top: framedTopPx,
            // Unrounded, like the flex centring of the window itself, so the two line up exactly.
            left: (parent.w - photo.width) / 2,
            width: photo.width,
            height: photo.height,
            pointerEvents: "none",
          }}
        >
          {photoAround({ gutter: Math.max(0, Math.floor((parent.w - photo.width) / 2)) })}
        </div>
      )}
      {framedPhoto && photoBelow}
    </>
  );
});
