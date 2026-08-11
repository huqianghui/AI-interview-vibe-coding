/**
 * Static roster of Azure Voice Live digital-human avatars for the editor's avatar grid.
 *
 * `character` + `style` are the two persona fields the backend maps to the Voice Live avatar config
 * (see backend/app/services/agents/voice_live_metadata.py — DEFAULT_AVATAR_CHARACTER="lisa",
 * DEFAULT_AVATAR_STYLE="casual-sitting"). The backend passes `style` through verbatim to Voice Live,
 * so the style ids here MUST be Azure's real slugs (e.g. "casual-sitting", not "casual").
 *
 * Thumbnails are the official Microsoft Learn CDN preview photos (real faces), matching the Azure AI
 * Foundry portal. Each URL was verified to resolve (200) against the CDN. The `swatch` color + the
 * name initial are the offline fallback when a thumbnail fails to load (see AvatarGrid onError).
 *
 * Two kinds, rendered video-first (matching the portal order):
 *   - **Video avatars**: multiple style variants, thumbnail `${CDN}/${id}-${style}.png`, driven as a
 *     live WebRTC H.264 stream during a real interview.
 *   - **Photo avatars**: single character, no style variants, thumbnail `${CDN}/${id}.png` (or, for a
 *     dozen of them, `${CDN}/${id}-avatar.png` — the actual filename on the CDN).
 */

export interface AvatarCharacter {
  /** Persona `character` value sent to the backend. */
  id: string;
  displayName: string;
  gender: "female" | "male";
  /** Photo avatars (VASA-1) have no style variants; video avatars do. */
  isPhotoAvatar: boolean;
  /** Selectable `style` values (Azure real slugs); empty for photo avatars. First is the default. */
  styles: readonly string[];
  /** Default style to select when this character is first picked ("" for photo avatars). */
  defaultStyle: string;
  /** Official MS Learn CDN preview photo (the character's default-style face). */
  thumbnailUrl: string;
  /** Fluent palette color used for the fallback swatch when the thumbnail fails to load. */
  swatch: string;
}

/** CDN base URL for official Azure avatar preview images. */
export const CDN_BASE =
  "https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech-avatar/media";

/** Build the CDN thumbnail URL for a video avatar's specific style. */
export function videoThumbnailUrl(id: string, style: string): string {
  return `${CDN_BASE}/${id}-${style}.png`;
}

// Fluent-ish palette for swatches (fallback only). Video avatars get distinct brand colors;
// photo avatars cycle a stable palette so a given id always maps to the same color.
const PHOTO_SWATCHES = [
  "#8764B8", "#0F6CBD", "#C239B3", "#107C10", "#D83B01", "#008272",
  "#5C2E91", "#986F0B", "#B4009E", "#005B70", "#A4262C", "#4F6BED",
];

function photoSwatch(index: number): string {
  return PHOTO_SWATCHES[index % PHOTO_SWATCHES.length];
}

// Photo-avatar ids whose CDN filename uses the `-avatar.png` suffix (verified against the CDN).
const PHOTO_AVATAR_SUFFIXED = new Set([
  "amira", "anika", "farhan", "faris", "hyejin", "imran",
  "liwei", "rahul", "ren", "riya", "sakura", "zayd",
]);

interface PhotoSeed {
  id: string;
  displayName: string;
  gender: "female" | "male";
}

// 27 photo avatars, in the portal's order.
const PHOTO_SEEDS: readonly PhotoSeed[] = [
  { id: "adrian", displayName: "Adrian", gender: "male" },
  { id: "amara", displayName: "Amara", gender: "female" },
  { id: "amira", displayName: "Amira", gender: "female" },
  { id: "anika", displayName: "Anika", gender: "female" },
  { id: "bianca", displayName: "Bianca", gender: "female" },
  { id: "camila", displayName: "Camila", gender: "female" },
  { id: "carlos", displayName: "Carlos", gender: "male" },
  { id: "clara", displayName: "Clara", gender: "female" },
  { id: "darius", displayName: "Darius", gender: "male" },
  { id: "diego", displayName: "Diego", gender: "male" },
  { id: "elise", displayName: "Elise", gender: "female" },
  { id: "farhan", displayName: "Farhan", gender: "male" },
  { id: "faris", displayName: "Faris", gender: "male" },
  { id: "gabrielle", displayName: "Gabrielle", gender: "female" },
  { id: "hyejin", displayName: "Hyejin", gender: "female" },
  { id: "imran", displayName: "Imran", gender: "male" },
  { id: "isabella", displayName: "Isabella", gender: "female" },
  { id: "layla", displayName: "Layla", gender: "female" },
  { id: "liwei", displayName: "Liwei", gender: "male" },
  { id: "ling", displayName: "Ling", gender: "female" },
  { id: "marcus", displayName: "Marcus", gender: "male" },
  { id: "matteo", displayName: "Matteo", gender: "male" },
  { id: "rahul", displayName: "Rahul", gender: "male" },
  { id: "rana", displayName: "Rana", gender: "female" },
  { id: "ren", displayName: "Ren", gender: "male" },
  { id: "riya", displayName: "Riya", gender: "female" },
  { id: "sakura", displayName: "Sakura", gender: "female" },
  { id: "simone", displayName: "Simone", gender: "female" },
  { id: "zayd", displayName: "Zayd", gender: "male" },
  { id: "zoe", displayName: "Zoe", gender: "female" },
];

function photoThumbnailUrl(id: string): string {
  return PHOTO_AVATAR_SUFFIXED.has(id) ? `${CDN_BASE}/${id}-avatar.png` : `${CDN_BASE}/${id}.png`;
}

const PHOTO_CHARACTERS: readonly AvatarCharacter[] = PHOTO_SEEDS.map((seed, i) => ({
  id: seed.id,
  displayName: seed.displayName,
  gender: seed.gender,
  isPhotoAvatar: true,
  styles: [],
  defaultStyle: "",
  thumbnailUrl: photoThumbnailUrl(seed.id),
  swatch: photoSwatch(i),
}));

// 6 video avatars (multiple styles each), in the portal's order.
const VIDEO_CHARACTERS: readonly AvatarCharacter[] = [
  {
    id: "lisa",
    displayName: "Lisa",
    gender: "female",
    isPhotoAvatar: false,
    styles: [
      "casual-sitting",
      "graceful-sitting",
      "graceful-standing",
      "technical-sitting",
      "technical-standing",
    ],
    defaultStyle: "casual-sitting",
    thumbnailUrl: videoThumbnailUrl("lisa", "casual-sitting"),
    swatch: "#6264A7",
  },
  {
    id: "harry",
    displayName: "Harry",
    gender: "male",
    isPhotoAvatar: false,
    styles: ["business", "casual", "youthful"],
    defaultStyle: "business",
    thumbnailUrl: videoThumbnailUrl("harry", "business"),
    swatch: "#0F6CBD",
  },
  {
    id: "meg",
    displayName: "Meg",
    gender: "female",
    isPhotoAvatar: false,
    styles: ["formal", "casual", "business"],
    defaultStyle: "formal",
    thumbnailUrl: videoThumbnailUrl("meg", "formal"),
    swatch: "#C239B3",
  },
  {
    id: "jeff",
    displayName: "Jeff",
    gender: "male",
    isPhotoAvatar: false,
    styles: ["business", "formal"],
    defaultStyle: "business",
    thumbnailUrl: videoThumbnailUrl("jeff", "business"),
    swatch: "#107C10",
  },
  {
    id: "lori",
    displayName: "Lori",
    gender: "female",
    isPhotoAvatar: false,
    styles: ["casual", "graceful", "formal"],
    defaultStyle: "casual",
    thumbnailUrl: videoThumbnailUrl("lori", "casual"),
    swatch: "#E3008C",
  },
  {
    id: "max",
    displayName: "Max",
    gender: "male",
    isPhotoAvatar: false,
    styles: ["business", "casual", "formal"],
    defaultStyle: "business",
    thumbnailUrl: videoThumbnailUrl("max", "business"),
    swatch: "#498205",
  },
];

/** All avatars, video-first then photo (matching the Azure AI Foundry portal order). */
export const AVATAR_CHARACTERS: readonly AvatarCharacter[] = [
  ...VIDEO_CHARACTERS,
  ...PHOTO_CHARACTERS,
];

/** Lookup by character id (for the static preview + style resolution). */
export const AVATAR_CHARACTER_MAP: ReadonlyMap<string, AvatarCharacter> = new Map(
  AVATAR_CHARACTERS.map((c) => [c.id, c]),
);

/** First-letter initial for the offline fallback swatch. */
export function getAvatarInitials(displayName: string): string {
  return displayName.charAt(0).toUpperCase();
}

/**
 * Resolve the CDN thumbnail for a character + (optional) style. Video avatars use the given style if
 * valid for the character (else the default style); photo avatars ignore style. Returns "" when the
 * character id is unknown.
 */
export function resolveThumbnailUrl(character: string, style: string): string {
  const meta = AVATAR_CHARACTER_MAP.get(character);
  if (!meta) return "";
  if (meta.isPhotoAvatar) return meta.thumbnailUrl;
  const resolvedStyle = meta.styles.includes(style) ? style : meta.defaultStyle;
  return videoThumbnailUrl(meta.id, resolvedStyle);
}

/** Backend default when a persona leaves character/style blank. */
export const DEFAULT_AVATAR_CHARACTER = "lisa";
export const DEFAULT_AVATAR_STYLE = "casual-sitting";
