/* eslint-disable @typescript-eslint/no-explicit-any */
// Filters are implemented with OpenCV.js (jscanify has no filter presets).
// Each takes the unmodified cropped canvas and returns a new canvas; the source is never modified.

export type FilterId = "original" | "grayscale" | "bw" | "enhanced";

export const FILTERS: { id: FilterId; label: string }[] = [
  { id: "original", label: "Original" },
  { id: "grayscale", label: "Grayscale" },
  { id: "bw", label: "Black & White" },
  { id: "enhanced", label: "Enhanced" },
];

type Mat = any;

/** Runs `fn` and deletes every Mat registered through `track`, even on error. */
function withMats<T>(fn: (track: <M extends Mat>(m: M) => M) => T): T {
  const mats: Mat[] = [];
  const track = <M extends Mat>(m: M) => {
    mats.push(m);
    return m;
  };
  try {
    return fn(track);
  } finally {
    for (const m of mats) m.delete();
  }
}

function toCanvas(mat: Mat): HTMLCanvasElement {
  const c = document.createElement("canvas");
  window.cv.imshow(c, mat);
  return c;
}

/**
 * Estimates the paper background (illumination) of a single-channel image: text is removed by
 * dilation + a large median blur. Done at 1/4 scale for speed, then resized back up.
 */
function estimateBackground(ch: Mat, track: <M extends Mat>(m: M) => M): Mat {
  const cv = window.cv;
  const small = track(new cv.Mat());
  cv.resize(ch, small, new cv.Size(0, 0), 0.25, 0.25, cv.INTER_AREA);
  const kernel = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));
  cv.dilate(small, small, kernel);
  cv.medianBlur(small, small, 21);
  const bg = track(new cv.Mat());
  cv.resize(small, bg, ch.size(), 0, 0, cv.INTER_LINEAR);
  return bg;
}

/** Divides a channel by its background, flattening shadows/uneven lighting (paper → ~255). */
function flattenChannel(ch: Mat, dst: Mat, track: <M extends Mat>(m: M) => M) {
  const bg = estimateBackground(ch, track);
  window.cv.divide(ch, bg, dst, 255);
}

function grayscale(src: HTMLCanvasElement): HTMLCanvasElement {
  const cv = window.cv;
  return withMats((track) => {
    const img = track(cv.imread(src));
    const gray = track(new cv.Mat());
    cv.cvtColor(img, gray, cv.COLOR_RGBA2GRAY);
    return toCanvas(gray);
  });
}

function blackAndWhite(src: HTMLCanvasElement): HTMLCanvasElement {
  const cv = window.cv;
  return withMats((track) => {
    const img = track(cv.imread(src));
    const gray = track(new cv.Mat());
    cv.cvtColor(img, gray, cv.COLOR_RGBA2GRAY);
    cv.medianBlur(gray, gray, 3);
    // Block size scales with the page so the local threshold window spans several text lines.
    let block = Math.round(Math.max(src.width, src.height) / 30);
    if (block % 2 === 0) block += 1;
    block = Math.max(15, block);
    const bw = track(new cv.Mat());
    cv.adaptiveThreshold(gray, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, 12);
    return toCanvas(bw);
  });
}

function enhanced(src: HTMLCanvasElement): HTMLCanvasElement {
  const cv = window.cv;
  return withMats((track) => {
    const img = track(cv.imread(src));
    const rgb = track(new cv.Mat());
    cv.cvtColor(img, rgb, cv.COLOR_RGBA2RGB);
    const channels = track(new cv.MatVector());
    cv.split(rgb, channels);
    const out = track(new cv.MatVector());
    for (let i = 0; i < 3; i++) {
      const ch = track(channels.get(i));
      const flat = track(new cv.Mat());
      flattenChannel(ch, flat, track);
      out.push_back(flat);
    }
    const merged = track(new cv.Mat());
    cv.merge(out, merged);
    // Mild contrast boost; no sharpening so faint pencil/handwriting survives.
    cv.convertScaleAbs(merged, merged, 1.15, -20);
    return toCanvas(merged);
  });
}

/** Note: "original" returns `src` itself (no copy, to save memory); never mutate the result. */
export function applyFilter(src: HTMLCanvasElement, id: FilterId): HTMLCanvasElement {
  switch (id) {
    case "original":
      return src;
    case "grayscale":
      return grayscale(src);
    case "bw":
      return blackAndWhite(src);
    case "enhanced":
      return enhanced(src);
  }
}
