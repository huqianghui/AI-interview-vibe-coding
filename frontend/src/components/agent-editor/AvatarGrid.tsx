/**
 * Avatar picker grid — real-face digital-human character + style selection, matching the Azure AI
 * Foundry portal's avatar gallery.
 *
 * Writes to the persona's `character`/`style` fields (the backend maps them to the Voice Live avatar
 * config). Each tile shows the official MS Learn CDN preview photo; if a thumbnail fails to load it
 * falls back to a colored swatch + the name initial, so the grid still works offline / in tests.
 * Video avatars render one tile per style (Lisa → 5 tiles); photo avatars render one tile (no style).
 * An all/photo/video filter narrows the roster.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Dropdown,
  Option,
  Text,
  ToggleButton,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import {
  AVATAR_CHARACTERS,
  AVATAR_CHARACTER_MAP,
  getAvatarInitials,
  videoThumbnailUrl,
} from "../../data/avatarCharacters";

type AvatarFilter = "all" | "video" | "photo";

interface GridTile {
  /** Unique key + failed-thumbnail tracking key (`id` for photo, `id-style` for video). */
  tileKey: string;
  characterId: string;
  displayName: string;
  style: string;
  styleLabel: string;
  isPhotoAvatar: boolean;
  thumbnailUrl: string;
  swatch: string;
}

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  filters: { display: "flex", gap: tokens.spacingHorizontalXS },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: tokens.spacingHorizontalS,
    maxHeight: "260px",
    overflowY: "auto",
    paddingRight: tokens.spacingHorizontalXS,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalXS,
    borderRadius: tokens.borderRadiusMedium,
    ...shorthands.border("2px", "solid", "transparent"),
    cursor: "pointer",
    backgroundColor: tokens.colorNeutralBackground1,
    textAlign: "center",
  },
  cardSelected: {
    ...shorthands.borderColor(tokens.colorBrandStroke1),
    backgroundColor: tokens.colorNeutralBackground1Selected,
  },
  thumbBox: {
    width: "100%",
    aspectRatio: "3 / 4",
    overflow: "hidden",
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  thumbImg: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  swatch: {
    width: "100%",
    aspectRatio: "3 / 4",
    borderRadius: tokens.borderRadiusSmall,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: tokens.colorNeutralForegroundOnBrand,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase400,
  },
  caption: { lineHeight: tokens.lineHeightBase200, width: "100%" },
});

const FILTERS: { value: AvatarFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "video", label: "Video" },
  { value: "photo", label: "Photo" },
];

export interface AvatarGridProps {
  character: string;
  style: string;
  onSelect: (character: string, style: string) => void;
  disabled?: boolean;
}

export function AvatarGrid({ character, style, onSelect, disabled }: AvatarGridProps) {
  const styles = useStyles();
  const [filter, setFilter] = useState<AvatarFilter>("all");

  // Track thumbnails that 404'd so we render the swatch fallback instead. A ref (not state) because
  // it's a cache; a version counter forces the re-render when a new failure is recorded.
  const failedThumbs = useRef(new Set<string>());
  const [, bumpFailed] = useState(0);
  const handleThumbError = useCallback((key: string) => {
    if (!failedThumbs.current.has(key)) {
      failedThumbs.current.add(key);
      bumpFailed((n) => n + 1);
    }
  }, []);

  const tiles = useMemo<GridTile[]>(() => {
    const out: GridTile[] = [];
    for (const c of AVATAR_CHARACTERS) {
      if (c.isPhotoAvatar) {
        if (filter === "video") continue;
        out.push({
          tileKey: c.id,
          characterId: c.id,
          displayName: c.displayName,
          style: "",
          styleLabel: "",
          isPhotoAvatar: true,
          thumbnailUrl: c.thumbnailUrl,
          swatch: c.swatch,
        });
      } else {
        if (filter === "photo") continue;
        for (const s of c.styles) {
          out.push({
            tileKey: `${c.id}-${s}`,
            characterId: c.id,
            displayName: c.displayName,
            style: s,
            styleLabel: s.replace(/-/g, " "),
            isPhotoAvatar: false,
            thumbnailUrl: videoThumbnailUrl(c.id, s),
            swatch: c.swatch,
          });
        }
      }
    }
    return out;
  }, [filter]);

  const selectedMeta = AVATAR_CHARACTER_MAP.get(character);
  const styleOptions = selectedMeta?.isPhotoAvatar ? [] : (selectedMeta?.styles ?? []);

  return (
    <div className={styles.root} data-testid="avatar-grid">
      <div className={styles.filters} role="tablist" aria-label="Avatar type filter">
        {FILTERS.map((f) => (
          <ToggleButton
            key={f.value}
            size="small"
            appearance={filter === f.value ? "primary" : "outline"}
            checked={filter === f.value}
            disabled={disabled}
            onClick={() => setFilter(f.value)}
            data-testid={`avatar-filter-${f.value}`}
          >
            {f.label}
          </ToggleButton>
        ))}
      </div>

      <div className={styles.grid}>
        {tiles.map((t) => {
          // A tile is selected when its character matches; for video avatars the style must match too
          // (so the right style-variant tile highlights), for photo avatars character alone suffices.
          const isSelected =
            t.characterId === character && (t.isPhotoAvatar || t.style === style);
          const imgFailed = failedThumbs.current.has(t.tileKey);
          return (
            <div
              key={t.tileKey}
              role="button"
              tabIndex={disabled ? -1 : 0}
              aria-pressed={isSelected}
              aria-disabled={disabled}
              aria-label={t.displayName + (t.styleLabel ? ` ${t.styleLabel}` : "")}
              data-testid={`avatar-option-${t.characterId}`}
              className={`${styles.card} ${isSelected ? styles.cardSelected : ""}`}
              onClick={() => !disabled && onSelect(t.characterId, t.style)}
              onKeyDown={(e) => {
                if (!disabled && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  onSelect(t.characterId, t.style);
                }
              }}
            >
              {imgFailed ? (
                <div className={styles.swatch} style={{ backgroundColor: t.swatch }}>
                  {getAvatarInitials(t.displayName)}
                </div>
              ) : (
                <div className={styles.thumbBox}>
                  <img
                    className={styles.thumbImg}
                    src={t.thumbnailUrl}
                    alt={t.displayName}
                    loading="lazy"
                    onError={() => handleThumbError(t.tileKey)}
                  />
                </div>
              )}
              <Text size={200} className={styles.caption}>
                {t.displayName}
                {t.styleLabel ? ` (${t.styleLabel})` : ""}
              </Text>
            </div>
          );
        })}
      </div>

      {/* Video avatars expose a style dropdown to refine the selected character's pose. */}
      {selectedMeta && !selectedMeta.isPhotoAvatar && (
        <Dropdown
          aria-label="Avatar style"
          data-testid="avatar-style-dropdown"
          disabled={disabled}
          selectedOptions={style ? [style] : []}
          value={style}
          onOptionSelect={(_, d) => onSelect(character, d.optionValue ?? styleOptions[0])}
        >
          {styleOptions.map((s) => (
            <Option key={s} value={s}>
              {s.replace(/-/g, " ")}
            </Option>
          ))}
        </Dropdown>
      )}
    </div>
  );
}
