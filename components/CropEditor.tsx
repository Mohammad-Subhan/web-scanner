"use client";

import { useEffect, useRef, useState } from "react";
import { mountCanvas, type Corners } from "@/lib/scanner";

type Key = keyof Corners;
const KEYS: Key[] = ["topLeftCorner", "topRightCorner", "bottomRightCorner", "bottomLeftCorner"];

interface Props {
  source: HTMLCanvasElement;
  initial: Corners;
  onApply: (corners: Corners) => void;
  onCancel: () => void;
}

/** Four draggable handles over the original image. Corners are kept in original-image pixels. */
export default function CropEditor({ source, initial, onApply, onCancel }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [corners, setCorners] = useState<Corners>(initial);
  // Displayed CSS pixels per original-image pixel.
  const [scale, setScale] = useState(0);
  const dragging = useRef<Key | null>(null);

  useEffect(() => {
    const detach = mountCanvas(hostRef.current!, source, { width: "100%", height: "auto" });
    const update = () => setScale(source.getBoundingClientRect().width / source.width);
    const ro = new ResizeObserver(update);
    ro.observe(source);
    update();
    return () => {
      ro.disconnect();
      detach();
    };
  }, [source]);

  const move = (e: React.PointerEvent) => {
    const key = dragging.current;
    if (!key) return;
    const rect = source.getBoundingClientRect();
    const x = Math.min(source.width, Math.max(0, (e.clientX - rect.left) / scale));
    const y = Math.min(source.height, Math.max(0, (e.clientY - rect.top) / scale));
    setCorners((c) => ({ ...c, [key]: { x, y } }));
  };

  const pts = KEYS.map((k) => corners[k]);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">Drag the four corners onto the page edges, then Apply Crop.</p>
      <div ref={hostRef} className="relative touch-none select-none">
        {scale > 0 && (
          <>
            <svg className="pointer-events-none absolute inset-0 h-full w-full">
              <polygon
                points={pts.map((p) => `${p.x * scale},${p.y * scale}`).join(" ")}
                fill="rgba(0,120,255,0.15)"
                stroke="#0a6cff"
                strokeWidth={2}
              />
            </svg>
            {KEYS.map((k) => (
              <div
                key={k}
                className="absolute h-11 w-11 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-blue-600 bg-white/40"
                style={{ left: corners[k].x * scale, top: corners[k].y * scale, touchAction: "none" }}
                onPointerDown={(e) => {
                  dragging.current = k;
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={move}
                onPointerUp={() => (dragging.current = null)}
                onPointerCancel={() => (dragging.current = null)}
              />
            ))}
          </>
        )}
      </div>
      <div className="flex gap-2">
        <button className="btn-primary flex-1 py-3" onClick={() => onApply(corners)}>
          Apply Crop
        </button>
        <button className="btn flex-1 py-3" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
