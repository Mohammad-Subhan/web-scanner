"use client";

import { useEffect, useRef, useState } from "react";
import { mountCanvas, setCanvasStyle } from "@/lib/scanner";

const ZOOMS = [1, 2, 4] as const;

/**
 * Shows a canvas directly (no re-encoding) inside a scrollable box with zoom levels.
 * "1:1" shows true image pixels for inspecting handwriting, edges and blur.
 */
export default function ZoomCanvas({ canvas, title }: { canvas: HTMLCanvasElement; title: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<number | "1:1">(1);
  const [full, setFull] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return mountCanvas(host, canvas, {});
  }, [canvas]);

  useEffect(() => {
    const width = zoom === "1:1" ? `${canvas.width / window.devicePixelRatio}px` : `${zoom * 100}%`;
    setCanvasStyle(canvas, { width, height: "auto" });
  }, [canvas, zoom]);

  return (
    <div className={full ? "fixed inset-0 z-50 flex flex-col bg-white p-2" : "flex flex-col"}>
      <div className="mb-1 flex flex-wrap items-center gap-1 text-sm">
        <span className="mr-auto font-semibold">{title}</span>
        {ZOOMS.map((z) => (
          <button key={z} className={`btn px-2 py-1 ${zoom === z ? "bg-gray-300" : ""}`} onClick={() => setZoom(z)}>
            {z}×
          </button>
        ))}
        <button className={`btn px-2 py-1 ${zoom === "1:1" ? "bg-gray-300" : ""}`} onClick={() => setZoom("1:1")}>
          1:1 px
        </button>
        <button className="btn px-2 py-1" onClick={() => setFull((f) => !f)}>
          {full ? "Close" : "Full"}
        </button>
      </div>
      <div
        ref={hostRef}
        className={`overflow-auto border border-gray-300 bg-gray-200 ${full ? "flex-1" : "max-h-[65vh]"}`}
      />
    </div>
  );
}
