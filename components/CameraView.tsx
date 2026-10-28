"use client";

import { useEffect, useRef, useState } from "react";
import { blobToCanvas, capturePhoto, startCamera, stopStream, type CaptureResult } from "@/lib/capture";
import { detectOn, getScanner, type Corners } from "@/lib/scanner";

const DETECT_INTERVAL_MS = 333; // ~3 detections per second
const DETECT_WIDTH = 320; // small frame for live detection

interface Props {
  scannerReady: boolean;
  onCapture: (result: CaptureResult, captureMs: number) => void;
  onError: (message: string) => void;
}

export default function CameraView({ scannerReady, onCapture, onError }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [streamInfo, setStreamInfo] = useState("");
  const [busy, setBusy] = useState(false);

  // Start camera; always release tracks on unmount (leaving camera mode).
  useEffect(() => {
    let cancelled = false;
    startCamera()
      .then(async (stream) => {
        if (cancelled) return stopStream(stream);
        streamRef.current = stream;
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play().catch(() => {});
        const s = stream.getVideoTracks()[0]?.getSettings();
        setStreamInfo(s ? `preview stream ${s.width}×${s.height}` : "");
      })
      .catch((e: Error) => !cancelled && setCameraError(e.message));
    return () => {
      cancelled = true;
      stopStream(streamRef.current);
      streamRef.current = null;
    };
  }, []);

  // Throttled live detection on a small frame; draws outline on the overlay.
  useEffect(() => {
    if (!scannerReady) return;
    const small = document.createElement("canvas");
    let running = false;
    let stopped = false;

    const tick = async () => {
      const video = videoRef.current;
      const overlay = overlayRef.current;
      if (running || stopped || !video || !overlay || !video.videoWidth) return;
      running = true;
      try {
        const scanner = await getScanner();
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        small.width = DETECT_WIDTH;
        small.height = Math.round((DETECT_WIDTH * vh) / vw);
        small.getContext("2d", { willReadFrequently: true })!.drawImage(video, 0, 0, small.width, small.height);
        const corners = detectOn(scanner, small);
        if (!stopped) drawOverlay(overlay, video, corners, vw / small.width);
      } catch {
        // Ignore transient errors in the live loop; final detection runs on the capture.
      } finally {
        running = false;
      }
    };

    const id = window.setInterval(tick, DETECT_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
      small.width = small.height = 0;
    };
  }, [scannerReady]);

  const capture = async () => {
    const stream = streamRef.current;
    const video = videoRef.current;
    if (!stream || !video) return;
    setBusy(true);
    try {
      const t0 = performance.now();
      const result = await capturePhoto(stream, video);
      onCapture(result, performance.now() - t0);
    } catch (e) {
      onError(`Capture failed: ${(e as Error).message}`);
      setBusy(false);
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const t0 = performance.now();
      const canvas = await blobToCanvas(file);
      onCapture({ canvas, blob: file, method: "upload" }, performance.now() - t0);
    } catch (e) {
      onError(`Could not read image: ${(e as Error).message}`);
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {cameraError ? (
        <div className="rounded border border-amber-400 bg-amber-50 p-3 text-sm">
          <p className="font-semibold">Camera unavailable</p>
          <p>{cameraError}</p>
        </div>
      ) : (
        <div className="relative h-[70vh] w-full bg-black">
          <video ref={videoRef} playsInline muted className="h-full w-full object-contain" />
          <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" />
          {!scannerReady && (
            <p className="absolute left-2 top-2 rounded bg-black/60 px-2 py-1 text-xs text-white">
              Loading detector…
            </p>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <button className="btn-primary flex-1 py-3 text-base" onClick={capture} disabled={busy || !!cameraError}>
          {busy ? "Capturing…" : "Capture"}
        </button>
        <button className="btn flex-1 py-3 text-base" onClick={() => fileRef.current?.click()} disabled={busy}>
          Upload Image
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            upload(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      {streamInfo && <p className="text-xs text-gray-500">{streamInfo}</p>}
    </div>
  );
}

/** Draws detected corners (in small-frame pixels) over the object-contain video. */
function drawOverlay(overlay: HTMLCanvasElement, video: HTMLVideoElement, c: Corners | null, toVideo: number) {
  const dpr = window.devicePixelRatio || 1;
  const bw = overlay.clientWidth;
  const bh = overlay.clientHeight;
  if (overlay.width !== Math.round(bw * dpr)) overlay.width = Math.round(bw * dpr);
  if (overlay.height !== Math.round(bh * dpr)) overlay.height = Math.round(bh * dpr);
  const ctx = overlay.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!c) return;

  // object-contain letterboxing: map video pixels to box CSS pixels.
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const s = Math.min(bw / vw, bh / vh);
  const ox = (bw - vw * s) / 2;
  const oy = (bh - vh * s) / 2;
  const map = (p: { x: number; y: number }) => [(ox + p.x * toVideo * s) * dpr, (oy + p.y * toVideo * s) * dpr] as const;

  const pts = [c.topLeftCorner, c.topRightCorner, c.bottomRightCorner, c.bottomLeftCorner].map(map);
  ctx.beginPath();
  ctx.moveTo(...pts[0]);
  for (const p of pts.slice(1)) ctx.lineTo(...p);
  ctx.closePath();
  ctx.fillStyle = "rgba(0, 220, 0, 0.15)";
  ctx.fill();
  ctx.lineWidth = 3 * dpr;
  ctx.strokeStyle = "#00e000";
  ctx.stroke();
}
