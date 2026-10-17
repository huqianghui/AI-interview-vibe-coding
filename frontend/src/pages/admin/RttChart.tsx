/** The Performance tab's live API round-trip chart: the last 5 minutes of samples as one line, with
 * the median and p95 as dashed guides and a crosshair tooltip on hover. One series, so no legend:
 * the caption names it. A failed sample breaks the line and is marked on the baseline. */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { makeStyles, tokens } from "@fluentui/react-components";
import { okRtts, type RttSample } from "./usePerformanceTab";
import { percentile } from "./performanceProbe";

const W = 600;
const H = 140;
const PAD = { left: 40, right: 12, top: 10, bottom: 18 };

const useStyles = makeStyles({
  wrap: { position: "relative", width: "100%", maxWidth: "960px" },
  svg: { width: "100%", height: "auto", display: "block", overflow: "visible" },
  tip: {
    position: "absolute",
    top: 0,
    transform: "translateX(-50%)",
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow8,
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "nowrap",
    pointerEvents: "none",
  },
});

/** A round axis top: the next 100 above the largest value, at least 100. */
function axisTop(values: number[]): number {
  return Math.max(100, Math.ceil(Math.max(0, ...values) / 100) * 100);
}

export function RttChart({ samples, capacity }: { samples: RttSample[]; capacity: number }) {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const [hover, setHover] = useState<number | null>(null);
  const values = okRtts(samples);
  const top = axisTop(values);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  // Fixed slots, newest on the right, so the line scrolls left as samples arrive.
  const x = (i: number) =>
    PAD.left + plotW * ((capacity - samples.length + i) / Math.max(1, capacity - 1));
  const y = (ms: number) => PAD.top + plotH * (1 - Math.min(ms, top) / top);

  // One path, broken at every failed sample.
  let d = "";
  let pen = false;
  samples.forEach((s, i) => {
    if (s.ms === null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(s.ms).toFixed(1)}`;
    pen = true;
  });
  const median = values.length ? percentile(values, 50) : null;
  const p95 = values.length ? percentile(values, 95) : null;
  const last = samples.length - 1;
  const ink = tokens.colorNeutralForeground3;
  const grid = tokens.colorNeutralStroke2;
  const line = tokens.colorBrandForeground1;

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    if (!samples.length) return;
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * plotW + PAD.left;
    let best = 0;
    samples.forEach((_, i) => {
      if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    });
    setHover(best);
  };
  const hovered = hover !== null ? samples[hover] : undefined;
  const time = (at: number) =>
    new Date(at).toLocaleTimeString(i18n.language, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

  return (
    <div className={styles.wrap} data-testid="performance-rtt-chart">
      <svg
        className={styles.svg}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={t("admin.performance.rttChart")}
      >
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(top * f)}
              y2={y(top * f)}
              stroke={grid}
              strokeWidth={1}
            />
            <text x={PAD.left - 6} y={y(top * f) + 4} textAnchor="end" fontSize={11} fill={ink}>
              {Math.round(top * f)}
            </text>
          </g>
        ))}
        {median !== null && p95 !== null && (
          <>
            {[
              {
                v: median,
                label: t("admin.performance.chartMedian", { ms: Math.round(median) }),
                // Below its line when the two guides are too close for both labels above.
                below: Math.abs(y(p95) - y(median)) < 14,
              },
              { v: p95, label: `p95 ${Math.round(p95)}`, below: false },
            ].map(({ v, label, below }) => (
              <g key={label}>
                <line
                  x1={PAD.left}
                  x2={W - PAD.right}
                  y1={y(v)}
                  y2={y(v)}
                  stroke={ink}
                  strokeWidth={1}
                  strokeDasharray="4 4"
                />
                {/* At the plot's left, haloed in the card colour, so the newest point and the
                    label never paint over each other. */}
                <text
                  x={PAD.left + 4}
                  y={below ? y(v) + 12 : y(v) - 4}
                  fontSize={11}
                  fill={ink}
                  stroke={tokens.colorNeutralBackground1}
                  strokeWidth={3}
                  paintOrder="stroke"
                >
                  {label}
                </text>
              </g>
            ))}
          </>
        )}
        <path d={d} fill="none" stroke={line} strokeWidth={2} strokeLinejoin="round" />
        {samples.map((s, i) =>
          s.ms === null ? (
            <text
              key={i}
              x={x(i)}
              y={H - PAD.bottom + 12}
              textAnchor="middle"
              fontSize={11}
              fill={ink}
            >
              ×
            </text>
          ) : null,
        )}
        {last >= 0 && samples[last].ms !== null && (
          <circle
            cx={x(last)}
            cy={y(samples[last].ms as number)}
            r={4}
            fill={line}
            stroke={tokens.colorNeutralBackground1}
            strokeWidth={2}
          />
        )}
        {hovered && hover !== null && (
          <>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={H - PAD.bottom}
              stroke={ink}
              strokeWidth={1}
            />
            {hovered.ms !== null && (
              <circle
                cx={x(hover)}
                cy={y(hovered.ms)}
                r={4}
                fill={line}
                stroke={tokens.colorNeutralBackground1}
                strokeWidth={2}
              />
            )}
          </>
        )}
        <rect
          x={PAD.left}
          y={PAD.top}
          width={plotW}
          height={plotH}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          data-testid="performance-rtt-hit"
        />
      </svg>
      {hovered && hover !== null && (
        <div
          className={styles.tip}
          // Kept inside the chart at the first and last sample.
          style={{ left: `${Math.min(88, Math.max(12, (x(hover) / W) * 100))}%` }}
          data-testid="performance-rtt-tip"
        >
          {t("admin.performance.chartTooltip", {
            time: time(hovered.at),
            ms:
              hovered.ms === null
                ? t("admin.performance.chartFailed")
                : `${Math.round(hovered.ms)} ms`,
          })}
        </div>
      )}
    </div>
  );
}
