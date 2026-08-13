/**
 * Static digital-human preview for the agent editor's center Playground column.
 *
 * Shows the selected avatar's real-face CDN photo (the Azure AI Foundry portal shows the character
 * standing in the middle of the Playground). This is a STATIC preview — no live WebRTC. During a real
 * interview the live video track is rendered by AvatarView on the /interview page instead; this
 * component intentionally does not touch that path.
 *
 * Fallbacks: if the thumbnail fails to load → colored swatch + name initial; if the persona has no
 * character (voice mode off) → the AudioOrb, so the preview always shows a presence.
 */
import { useEffect, useState } from "react";
import { Text, makeStyles, tokens } from "@fluentui/react-components";
import { AudioOrb } from "../AudioOrb";
import { AVATAR_CHARACTER_MAP, getAvatarInitials, resolveThumbnailUrl } from "../../data/avatarCharacters";

const useStyles = makeStyles({
  root: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: tokens.spacingVerticalS,
    minHeight: "480px",
    height: "100%",
    width: "100%",
    background: `linear-gradient(180deg, ${tokens.colorNeutralBackground2} 0%, ${tokens.colorNeutralBackground3} 100%)`,
    borderRadius: tokens.borderRadiusLarge,
  },
  img: {
    // Fill the (now larger) center column; the digital human should read as the dominant element.
    maxHeight: "100%",
    height: "min(72vh, 100%)",
    maxWidth: "100%",
    width: "auto",
    objectFit: "contain",
    filter: "drop-shadow(0 6px 16px rgba(0,0,0,0.18))",
  },
  swatch: {
    // Proportional to the viewport so the fallback isn't a tiny fixed box in a big column.
    width: "min(38vw, 300px)",
    height: "min(50vw, 400px)",
    borderRadius: tokens.borderRadiusMedium,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: tokens.colorNeutralForegroundOnBrand,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeHero900,
  },
  caption: { color: tokens.colorNeutralForeground2 },
});

export interface AvatarPreviewProps {
  character: string;
  style: string;
}

export function AvatarPreview({ character, style }: AvatarPreviewProps) {
  const styles = useStyles();
  const [imgError, setImgError] = useState(false);

  const meta = AVATAR_CHARACTER_MAP.get(character);
  const thumbnailUrl = resolveThumbnailUrl(character, style);

  // Reset the error flag when the selection changes so a new pick re-attempts its thumbnail.
  useEffect(() => {
    setImgError(false);
  }, [thumbnailUrl]);

  // Voice mode off (no character): show the orb presence.
  if (!meta) {
    return (
      <div className={styles.root} data-testid="avatar-preview" data-avatar-character="">
        <AudioOrb audioState="idle" />
        <Text size={200} className={styles.caption}>
          Voice-only (no avatar)
        </Text>
      </div>
    );
  }

  return (
    <div className={styles.root} data-testid="avatar-preview" data-avatar-character={character}>
      {imgError || !thumbnailUrl ? (
        <div className={styles.swatch} style={{ backgroundColor: meta.swatch }}>
          {getAvatarInitials(meta.displayName)}
        </div>
      ) : (
        <img
          className={styles.img}
          src={thumbnailUrl}
          alt={meta.displayName}
          onError={() => setImgError(true)}
          data-testid="avatar-preview-img"
        />
      )}
      <Text size={200} className={styles.caption}>
        {meta.displayName}
        {!meta.isPhotoAvatar && style ? ` · ${style.replace(/-/g, " ")}` : ""}
      </Text>
    </div>
  );
}
