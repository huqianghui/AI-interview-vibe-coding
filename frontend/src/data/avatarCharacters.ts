/**
 * Static roster of Azure Voice Live digital-human avatars for the editor's avatar grid (Phase 3).
 *
 * `character` + `style` are the two persona fields the backend maps to the Voice Live avatar config
 * (see backend/app/services/agents/voice_live_metadata.py — DEFAULT_AVATAR_CHARACTER="lisa",
 * DEFAULT_AVATAR_STYLE="casual"). Trimmed to a small set of the standard video avatars; no photo
 * avatars and no CDN thumbnails (swatches only, so the grid renders offline and in tests). Each
 * character carries a stable Fluent palette color for its swatch.
 */
export interface AvatarCharacter {
  /** Persona `character` value sent to the backend. */
  id: string;
  displayName: string;
  /** Selectable `style` values for this character; first is the default. */
  styles: string[];
  /** A Fluent color-palette token name used for the swatch background. */
  swatch: string;
}

export const AVATAR_CHARACTERS: readonly AvatarCharacter[] = [
  { id: "lisa", displayName: "Lisa", styles: ["casual", "graceful", "technical"], swatch: "#6264A7" },
  { id: "harry", displayName: "Harry", styles: ["casual", "business", "youthful"], swatch: "#0F6CBD" },
  { id: "meg", displayName: "Meg", styles: ["formal", "casual", "business"], swatch: "#C239B3" },
  { id: "jeff", displayName: "Jeff", styles: ["business", "formal"], swatch: "#107C10" },
] as const;

/** Backend default when a persona leaves character/style blank. */
export const DEFAULT_AVATAR_CHARACTER = "lisa";
export const DEFAULT_AVATAR_STYLE = "casual";
