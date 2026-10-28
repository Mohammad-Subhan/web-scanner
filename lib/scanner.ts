import type jscanify from "jscanify/client";
import type { CornerPoints, Point } from "jscanify/client";
import { loadOpenCV } from "./opencv";

export type Corners = Required<CornerPoints>;

// jscanify's Canny/blur parameters are fixed and tuned for moderate image sizes; on 12 MP
// photos paper texture and handwriting produce noisy edges and detection is slow. Detection
// therefore runs on a copy of the full capture limited to this long side, and the resulting
// corners are scaled back up. Extraction always uses the full-resolution image.
export const DETECT_MAX_SIDE = 1600;
// Upper bound for the perspective-corrected output, to keep memory sane on phones.
export const OUTPUT_MAX_SIDE = 4000;

let scannerPromise: Promise<jscanify> | null = null;

/** Single jscanify instance, created after OpenCV is ready. */
export function getScanner(): Promise<jscanify> {
  if (!scannerPromise) {
    scannerPromise = (async () => {
      await loadOpenCV();
      const mod = await import("jscanify/client");
      return new mod.default();
    })();
    scannerPromise.catch(() => {
      scannerPromise = null;
    });
  }
  return scannerPromise;
}

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Attaches an existing canvas to a host element (canvases are displayed directly, never
 * re-encoded). Returns a detach function.
 */
export function mountCanvas(host: HTMLElement, canvas: HTMLCanvasElement, style: Partial<CSSStyleDeclaration>) {
  Object.assign(canvas.style, { display: "block", maxWidth: "none", ...style });
  host.prepend(canvas);
  return () => {
    if (canvas.parentNode === host) host.removeChild(canvas);
  };
}

export function setCanvasStyle(canvas: HTMLCanvasElement, style: Partial<CSSStyleDeclaration>) {
  Object.assign(canvas.style, style);
}

/** Frees a canvas's backing store (important on mobile Safari). */
export function releaseCanvas(c: HTMLCanvasElement | null | undefined) {
  if (!c) return;
  c.width = 0;
  c.height = 0;
}

/** Returns a downscaled copy (or the same canvas if already small enough) and the scale used. */
export function downscale(src: HTMLCanvasElement, maxSide: number): { canvas: HTMLCanvasElement; scale: number } {
  const longSide = Math.max(src.width, src.height);
  if (longSide <= maxSide) return { canvas: src, scale: 1 };
  const scale = maxSide / longSide;
  const c = createCanvas(Math.round(src.width * scale), Math.round(src.height * scale));
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return { canvas: c, scale };
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * jscanify's findPaperContour always returns the largest contour, even when there is no
 * document. Reject results that are not a plausible page.
 */
export function isPlausibleDocument(c: CornerPoints, frameW: number, frameH: number): c is Corners {
  const { topLeftCorner: tl, topRightCorner: tr, bottomRightCorner: br, bottomLeftCorner: bl } = c;
  if (!tl || !tr || !br || !bl) return false;

  const quad = [tl, tr, br, bl];
  // Convexity: all cross products of consecutive edges share a sign.
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const d = quad[(i + 2) % 4];
    const cross = (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x);
    if (cross === 0) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }

  // Shoelace area.
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  area = Math.abs(area) / 2;
  if (area < 0.15 * frameW * frameH) return false;

  const minSide = 0.1 * Math.min(frameW, frameH);
  for (let i = 0; i < 4; i++) {
    if (dist(quad[i], quad[(i + 1) % 4]) < minSide) return false;
  }
  return true;
}

/** Runs jscanify detection on `canvas` as-is. Caller is responsible for sizing. */
export function detectOn(scanner: jscanify, canvas: HTMLCanvasElement): Corners | null {
  const cv = window.cv;
  let img: { delete(): void } | null = null;
  let contour: { delete(): void } | null = null;
  try {
    img = cv.imread(canvas);
    contour = scanner.findPaperContour(img);
    if (!contour) return null;
    const corners = scanner.getCornerPoints(contour);
    return isPlausibleDocument(corners, canvas.width, canvas.height) ? corners : null;
  } finally {
    contour?.delete();
    img?.delete();
  }
}

const scaleCorners = (c: Corners, s: number): Corners => ({
  topLeftCorner: { x: c.topLeftCorner.x * s, y: c.topLeftCorner.y * s },
  topRightCorner: { x: c.topRightCorner.x * s, y: c.topRightCorner.y * s },
  bottomLeftCorner: { x: c.bottomLeftCorner.x * s, y: c.bottomLeftCorner.y * s },
  bottomRightCorner: { x: c.bottomRightCorner.x * s, y: c.bottomRightCorner.y * s },
});

/** Detects the document in a full-resolution capture; corners are in full-resolution pixels. */
export async function detectCorners(full: HTMLCanvasElement): Promise<Corners | null> {
  const scanner = await getScanner();
  const { canvas, scale } = downscale(full, DETECT_MAX_SIDE);
  try {
    const corners = detectOn(scanner, canvas);
    return corners ? scaleCorners(corners, 1 / scale) : null;
  } finally {
    if (canvas !== full) releaseCanvas(canvas);
  }
}

/** Output size taken from the document's own edge lengths, so the page is not stretched. */
export function outputSize(c: Corners): { width: number; height: number } {
  let width = Math.max(dist(c.topLeftCorner, c.topRightCorner), dist(c.bottomLeftCorner, c.bottomRightCorner));
  let height = Math.max(dist(c.topLeftCorner, c.bottomLeftCorner), dist(c.topRightCorner, c.bottomRightCorner));
  const longSide = Math.max(width, height);
  if (longSide > OUTPUT_MAX_SIDE) {
    const s = OUTPUT_MAX_SIDE / longSide;
    width *= s;
    height *= s;
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

/** Crop + perspective correction with jscanify's extractPaper using explicit corners. */
export async function extract(full: HTMLCanvasElement, corners: Corners): Promise<HTMLCanvasElement> {
  const scanner = await getScanner();
  const { width, height } = outputSize(corners);
  const result = scanner.extractPaper(full, width, height, corners);
  if (!result) throw new Error("extractPaper returned no result");
  return result;
}

/**
 * jscanify's highlightPaper on the same downscaled copy used for detection, so the overlay
 * shows exactly what the detector saw.
 */
export async function highlight(full: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  const scanner = await getScanner();
  const { canvas } = downscale(full, DETECT_MAX_SIDE);
  try {
    const thickness = Math.max(4, Math.round(Math.max(canvas.width, canvas.height) / 200));
    return scanner.highlightPaper(canvas, { color: "#00e000", thickness });
  } finally {
    if (canvas !== full) releaseCanvas(canvas);
  }
}

/** Default corners for manual cropping when detection failed: a 10% inset rectangle. */
export function insetCorners(w: number, h: number): Corners {
  const dx = w * 0.1;
  const dy = h * 0.1;
  return {
    topLeftCorner: { x: dx, y: dy },
    topRightCorner: { x: w - dx, y: dy },
    bottomLeftCorner: { x: dx, y: h - dy },
    bottomRightCorner: { x: w - dx, y: h - dy },
  };
}
