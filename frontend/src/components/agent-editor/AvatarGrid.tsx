/**
 * Avatar picker grid (Phase 3) — selectable digital-human character + style swatches.
 *
 * Writes to the persona's `character`/`style` fields (the backend maps them to the Voice Live
 * avatar config). Swatches are colored squares (no CDN thumbnails) so the grid is offline-safe.
 * Selecting a character defaults its style; a per-character style dropdown refines it.
 */
import {
  Dropdown,
  Option,
  Text,
  makeStyles,
  shorthands,
  tokens,
} from "@fluentui/react-components";
import { AVATAR_CHARACTERS } from "../../data/avatarCharacters";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: tokens.spacingHorizontalS,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    ...shorthands.border("2px", "solid", "transparent"),
    cursor: "pointer",
    backgroundColor: tokens.colorNeutralBackground1,
  },
  cardSelected: {
    ...shorthands.borderColor(tokens.colorBrandStroke1),
    backgroundColor: tokens.colorNeutralBackground1Selected,
  },
  swatch: {
    width: "48px",
    height: "48px",
    borderRadius: tokens.borderRadiusMedium,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: tokens.colorNeutralForegroundOnBrand,
    fontWeight: tokens.fontWeightSemibold,
  },
});

export interface AvatarGridProps {
  character: string;
  style: string;
  onSelect: (character: string, style: string) => void;
  disabled?: boolean;
}

export function AvatarGrid({ character, style, onSelect, disabled }: AvatarGridProps) {
  const styles = useStyles();
  const selected = AVATAR_CHARACTERS.find((c) => c.id === character);
  const styleOptions = selected?.styles ?? [];

  return (
    <div className={styles.root} data-testid="avatar-grid">
      <div className={styles.grid}>
        {AVATAR_CHARACTERS.map((c) => {
          const isSelected = c.id === character;
          return (
            <div
              key={c.id}
              role="button"
              tabIndex={disabled ? -1 : 0}
              aria-pressed={isSelected}
              aria-disabled={disabled}
              data-testid={`avatar-option-${c.id}`}
              className={`${styles.card} ${isSelected ? styles.cardSelected : ""}`}
              onClick={() => !disabled && onSelect(c.id, c.styles[0])}
              onKeyDown={(e) => {
                if (!disabled && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  onSelect(c.id, c.styles[0]);
                }
              }}
            >
              <div className={styles.swatch} style={{ backgroundColor: c.swatch }}>
                {c.displayName[0]}
              </div>
              <Text size={200}>{c.displayName}</Text>
            </div>
          );
        })}
      </div>
      {selected && (
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
              {s}
            </Option>
          ))}
        </Dropdown>
      )}
    </div>
  );
}
