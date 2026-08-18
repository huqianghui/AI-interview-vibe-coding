/**
 * AvatarView (SPEC F5/F9) — the interviewer's visual presence.
 *
 * Layers, in order:
 * 1. A `<video>` element (always in the DOM so `ontrack` can attach a stream at any time) — shown
 *    once a real digital-human avatar video track arrives from Voice Live.
 * 2. The AudioOrb — shown when there's no avatar video (voice-only session, or avatar still
 *    negotiating, or the persona has no character). So the page always has a presence.
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
import { forwardRef } from "react";
import { makeStyles, mergeClasses } from "@fluentui/react-components";
import { AudioOrb } from "./AudioOrb";
import type { AudioState } from "../types/voice";

const useStyles = makeStyles({
  root: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    // Fill the (flex-grown) stage so the avatar video is as large as the space allows, rather than a
    // fixed small box. minHeight:0 so it never forces the bounded stage to overflow the viewport.
    width: "100%",
    height: "100%",
    minHeight: 0,
  },
  video: {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    // `cover` (not `contain`): fill the full stage so a 16:9 stream uses the whole (taller) panel
    // instead of leaving dark letterbox bands above/below the figure. The avatar frame is a
    // centered person on wide white margins, so `cover` crops those side margins — never the
    // figure. Anchored to the top so the head is the last thing sacrificed if the crop is tight.
    objectFit: "cover",
    objectPosition: "center top",
    borderRadius: "12px",
    transition: "opacity 300ms ease",
  },
  hidden: { opacity: 0, zIndex: 0, pointerEvents: "none" },
  shown: { opacity: 1, zIndex: 10 },
});

interface AvatarViewProps {
  audioState: AudioState;
  /** True once a real avatar video track is playing → show video, hide the orb. */
  isAvatarConnected: boolean;
}

/** Ref is the `<video>` element the voice hook attaches the avatar stream to (via `videoRef`). */
export const AvatarView = forwardRef<HTMLVideoElement, AvatarViewProps>(function AvatarView(
  { audioState, isAvatarConnected },
  ref,
) {
  const styles = useStyles();
  return (
    <div className={styles.root} data-testid="avatar-view" data-avatar-connected={isAvatarConnected}>
      <video
        ref={ref}
        autoPlay
        playsInline
        muted
        className={mergeClasses(styles.video, isAvatarConnected ? styles.shown : styles.hidden)}
        data-testid="avatar-video"
      />
      {!isAvatarConnected && <AudioOrb audioState={audioState} />}
    </div>
  );
});
