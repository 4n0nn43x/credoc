import { useEffect, useRef } from "react";
import ApexCharts, { type ApexOptions } from "apexcharts";
import { useTheme } from "../../shared/theme";

/** Thin ApexCharts wrapper (ApexCharts 3 matches Osen's chart styles). Toolbar off, ink palette that follows the theme. */
export default function Chart({ options, height = 260 }: { options: ApexOptions; height?: number }) {
  const dark = useTheme() === "dark";
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ApexCharts | null>(null);
  const json = JSON.stringify(options);
  useEffect(() => {
    if (!el.current) return;
    chart.current = new ApexCharts(el.current, {
      ...options,
      chart: {
        fontFamily: "Inter, sans-serif",
        toolbar: { show: false },
        zoom: { enabled: false },
        animations: { enabled: !window.matchMedia("(prefers-reduced-motion: reduce)").matches },
        foreColor: dark ? "#9a968f" : "#78716c",
        background: "transparent",
        ...options.chart,
        height,
      },
      theme: { mode: dark ? "dark" : "light" },
      tooltip: { theme: dark ? "dark" : "light", ...options.tooltip },
      grid: { borderColor: dark ? "#2e2d2b" : "#eceae8", strokeDashArray: 3, ...options.grid },
      colors: options.colors ?? (dark ? ["#ecebe8", "#9a968f", "#57534e"] : ["#191919", "#a8a29e", "#d6d3d1"]),
      dataLabels: { enabled: false, ...options.dataLabels },
      legend: { show: (options.series?.length ?? 0) > 1, ...options.legend },
    });
    void chart.current.render();
    return () => {
      chart.current?.destroy();
      chart.current = null;
    };
    // re-render when the serialized options change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [json, height, dark]);
  return <div ref={el} />;
}
