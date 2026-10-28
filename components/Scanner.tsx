"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import CameraView from "./CameraView";
import CropEditor from "./CropEditor";
import ZoomCanvas from "./ZoomCanvas";
import { blobToCanvas, canvasToBlob, type CaptureMethod, type CaptureResult } from "@/lib/capture";
import { applyFilter, FILTERS, type FilterId } from "@/lib/filters";
import {
  createCanvas,
  DETECT_MAX_SIDE,
  detectCorners,
  downscale,
  extract,
  getScanner,
  highlight,
  insetCorners,
  releaseCanvas,
  type Corners,
} from "@/lib/scanner";

type Mode = "camera" | "processing" | "preview" | "crop" | "pages";
/** auto = jscanify detection, manual = user corners, uncropped = user kept full photo, none = detection failed */
type CropSource = "auto" | "manual" | "uncropped" | "none";

interface Stats {
  captureMs: number;
  detectMs?: number;
  extractMs?: number;
  filterMs?: number;
}

interface Draft {
  source: CaptureResult;
  detected: Corners | null;
  corners: Corners | null;
  cropSource: CropSource;
  /** Unmodified crop + perspective-corrected image; filters always start from this. */
  cropped: HTMLCanvasElement | null;
  outputs: Partial<Record<FilterId, HTMLCanvasElement>>;
  filter: FilterId;
  highlight?: HTMLCanvasElement;
  stats: Stats;
}

interface Page {
  id: number;
  /** Original capture bytes (not re-encoded) for re-processing. */
  blob: Blob;
  method: CaptureMethod;
  detected: Corners | null;
  corners: Corners | null;
  cropSource: CropSource;
  filter: FilterId;
  /** Final output, encoded once as JPEG q=0.95. */
  output: Blob;
  width: number;
  height: number;
  thumb: string;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  const result = await fn();
  return [result, performance.now() - t];
}
const ms = (v?: number) => (v === undefined ? "—" : `${Math.round(v)} ms`);
let pageId = 0;

function releaseDraft(d: Draft | null) {
  if (!d) return;
  const canvases = new Set<HTMLCanvasElement | null | undefined>([
    d.source.canvas,
    d.cropped,
    d.highlight,
    ...Object.values(d.outputs),
  ]);
  canvases.forEach(releaseCanvas);
}

function cloneCanvas(src: HTMLCanvasElement) {
  const c = createCanvas(src.width, src.height);
  c.getContext("2d")!.drawImage(src, 0, 0);
  return c;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const CROP_LABEL: Record<CropSource, string> = {
  auto: "Auto-detected (jscanify)",
  manual: "Manual corners",
  uncropped: "Not cropped (original kept)",
  none: "NOT detected",
};

export default function Scanner() {
  const [cvState, setCvState] = useState<"loading" | "ready" | "error">("loading");
  const [mode, setMode] = useState<Mode>("camera");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHighlight, setShowHighlight] = useState(false);
  const draftRef = useRef<Draft | null>(null);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    getScanner()
      .then(() => setCvState("ready"))
      .catch((e: Error) => {
        setCvState("error");
        setError(`OpenCV / jscanify failed to load: ${e.message}`);
      });
    return () => releaseDraft(draftRef.current);
  }, []);

  /** Computes (and memoizes) a filter output on the draft, mutating it in place. */
  const ensureFilter = useCallback(async (d: Draft, id: FilterId) => {
    if (!d.cropped || d.outputs[id]) return;
    setBusy("Applying filter…");
    await nextFrame();
    const cropped = d.cropped;
    const [out, filterMs] = await timed(async () => applyFilter(cropped, id));
    d.outputs[id] = out;
    d.stats = { ...d.stats, filterMs };
  }, []);

  const discardDraft = () => {
    releaseDraft(draftRef.current);
    setDraft(null);
    setShowHighlight(false);
  };

  const processCapture = async (
    source: CaptureResult,
    captureMs: number,
    preset?: Pick<Page, "detected" | "corners" | "cropSource" | "filter">,
  ) => {
    setMode("processing");
    setShowHighlight(false);
    setBusy(cvState === "ready" ? "Detecting document…" : "Waiting for OpenCV to load…");
    await nextFrame();
    try {
      await getScanner();
      const stats: Stats = { captureMs };
      let detected: Corners | null;
      let corners: Corners | null;
      if (preset) {
        detected = preset.detected;
        corners = preset.corners;
      } else {
        setBusy("Detecting document…");
        await nextFrame();
        [detected, stats.detectMs] = await timed(() => detectCorners(source.canvas));
        corners = detected;
      }

      let cropped: HTMLCanvasElement | null = null;
      if (corners) {
        setBusy("Cropping & correcting perspective…");
        await nextFrame();
        const c = corners;
        [cropped, stats.extractMs] = await timed(() => extract(source.canvas, c));
      } else if (preset?.cropSource === "uncropped") {
        cropped = cloneCanvas(source.canvas);
      }

      const d: Draft = {
        source,
        detected,
        corners,
        cropSource: preset?.cropSource ?? (detected ? "auto" : "none"),
        cropped,
        outputs: cropped ? { original: cropped } : {},
        filter: preset?.filter ?? "original",
        stats,
      };
      await ensureFilter(d, d.filter);
      setDraft(d);
      setMode("preview");
    } catch (e) {
      releaseCanvas(source.canvas);
      setError(`Processing failed: ${(e as Error).message}`);
      setMode("camera");
    } finally {
      setBusy(null);
    }
  };

  /** Replaces the crop of the current draft, resetting filter outputs. */
  const recrop = async (corners: Corners | null, cropSource: CropSource) => {
    const d = draftRef.current;
    if (!d) return;
    setMode("processing");
    setBusy("Cropping & correcting perspective…");
    await nextFrame();
    try {
      const [cropped, extractMs] = await timed(async () =>
        corners ? extract(d.source.canvas, corners) : cloneCanvas(d.source.canvas),
      );
      new Set([d.cropped, ...Object.values(d.outputs)]).forEach(releaseCanvas);
      const next: Draft = {
        ...d,
        corners,
        cropSource,
        cropped,
        outputs: { original: cropped },
        stats: { ...d.stats, extractMs, filterMs: undefined },
      };
      await ensureFilter(next, next.filter);
      setDraft(next);
    } catch (e) {
      setError(`Crop failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
      setMode("preview");
    }
  };

  const selectFilter = async (id: FilterId) => {
    const d = draftRef.current;
    if (!d) return;
    try {
      await ensureFilter(d, id);
      setDraft({ ...d, filter: id });
    } catch (e) {
      setError(`Filter failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const toggleHighlight = async () => {
    const d = draftRef.current;
    if (!d) return;
    if (!d.highlight) {
      setBusy("Running highlightPaper…");
      await nextFrame();
      try {
        d.highlight = await highlight(d.source.canvas);
      } catch (e) {
        setError(`highlightPaper failed: ${(e as Error).message}`);
        return;
      } finally {
        setBusy(null);
      }
      setDraft({ ...d });
    }
    setShowHighlight((s) => !s);
  };

  const savePage = async (next: "pages" | "camera") => {
    const d = draftRef.current;
    const out = d?.outputs[d.filter];
    if (!d || !out) return;
    setBusy("Saving page…");
    await nextFrame();
    try {
      const output = await canvasToBlob(out, "image/jpeg", 0.95);
      const { canvas: small } = downscale(out, 240);
      const thumb = small.toDataURL("image/jpeg", 0.7);
      if (small !== out) releaseCanvas(small);
      const page: Page = {
        id: ++pageId,
        blob: d.source.blob,
        method: d.source.method,
        detected: d.detected,
        corners: d.corners,
        cropSource: d.cropSource,
        filter: d.filter,
        output,
        width: out.width,
        height: out.height,
        thumb,
      };
      setPages((ps) => {
        if (editIndex !== null && editIndex < ps.length) {
          const copy = ps.slice();
          copy[editIndex] = page;
          return copy;
        }
        return [...ps, page];
      });
      setEditIndex(null);
      discardDraft();
      setMode(next);
    } catch (e) {
      setError(`Save failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const confirmDiscard = () =>
    !draftRef.current || mode !== "preview" || window.confirm("Discard the current unsaved scan?");

  const openPage = async (i: number) => {
    if (!confirmDiscard()) return;
    discardDraft();
    const p = pages[i];
    setEditIndex(i);
    setMode("processing");
    setBusy("Loading page…");
    try {
      const canvas = await blobToCanvas(p.blob);
      await processCapture({ canvas, blob: p.blob, method: p.method }, 0, p);
    } catch (e) {
      setError(`Could not open page: ${(e as Error).message}`);
      setBusy(null);
      setMode("pages");
    }
  };

  const retakePage = (i: number) => {
    if (!confirmDiscard()) return;
    discardDraft();
    setEditIndex(i);
    setMode("camera");
  };

  const deletePage = (i: number) => {
    if (!window.confirm(`Delete page ${i + 1}?`)) return;
    setPages((ps) => ps.filter((_, j) => j !== i));
    if (editIndex === i) {
      discardDraft();
      setEditIndex(null);
      setMode("pages");
    } else if (editIndex !== null && editIndex > i) {
      setEditIndex(editIndex - 1);
    }
  };

  const addPage = () => {
    if (!confirmDiscard()) return;
    discardDraft();
    setEditIndex(null);
    setMode("camera");
  };

  const downloadPdf = async () => {
    if (!pages.length) return;
    setBusy("Building PDF…");
    try {
      const { jsPDF } = await import("jspdf");
      let doc: InstanceType<typeof jsPDF> | null = null;
      for (const p of pages) {
        // Page size follows the scan's aspect ratio (595 pt = A4 width).
        const w = 595;
        const h = (w * p.height) / p.width;
        const orientation = h >= w ? "p" : "l";
        if (!doc) doc = new jsPDF({ unit: "pt", format: [w, h], orientation });
        else doc.addPage([w, h], orientation);
        // JPEG bytes are embedded as-is (no re-compression).
        doc.addImage(new Uint8Array(await p.output.arrayBuffer()), "JPEG", 0, 0, w, h);
      }
      doc!.save(`scan-${pages.length}-pages.pdf`);
    } catch (e) {
      setError(`PDF failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const downloadCurrentPng = async () => {
    const out = draft?.outputs[draft.filter];
    if (!out) return;
    setBusy("Encoding PNG…");
    await nextFrame();
    try {
      download(await canvasToBlob(out, "image/png"), `scan-${draft!.filter}.png`);
    } finally {
      setBusy(null);
    }
  };

  const current = draft?.outputs[draft.filter];

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-3 p-3">
      <header className="flex items-center justify-between">
        <h1 className="text-base font-bold">Check8 Web Scanner (test)</h1>
        <span className="text-xs text-gray-600">
          OpenCV: {cvState === "loading" ? "loading…" : cvState === "ready" ? "ready" : "failed"}
        </span>
      </header>

      {error && (
        <div className="flex items-start gap-2 rounded border border-red-400 bg-red-50 p-2 text-sm text-red-800">
          <span className="flex-1">{error}</span>
          <button className="btn px-2 py-0.5" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}

      {busy && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
          <div className="rounded bg-white px-4 py-3 text-sm font-medium shadow">{busy}</div>
        </div>
      )}

      {editIndex !== null && (mode === "camera" || mode === "preview" || mode === "crop") && (
        <p className="text-sm text-blue-800">Editing / replacing page {editIndex + 1}</p>
      )}

      {mode === "camera" && (
        <>
          <CameraView
            scannerReady={cvState === "ready"}
            onCapture={(r, t) => processCapture(r, t)}
            onError={setError}
          />
          {pages.length > 0 && (
            <button
              className="btn"
              onClick={() => {
                setEditIndex(null);
                setMode("pages");
              }}
            >
              Back to pages
            </button>
          )}
        </>
      )}

      {mode === "preview" && draft && (
        <section className="flex flex-col gap-3">
          {draft.cropSource === "none" && (
            <div className="rounded border border-amber-500 bg-amber-50 p-3 text-sm">
              <p className="font-semibold">Document not detected.</p>
              <p>Adjust the crop manually, or keep the original (uncropped) image.</p>
              <div className="mt-2 flex gap-2">
                <button className="btn-primary" onClick={() => setMode("crop")}>
                  Adjust Crop
                </button>
                <button className="btn" onClick={() => recrop(null, "uncropped")}>
                  Keep original
                </button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <ZoomCanvas
                canvas={showHighlight && draft.highlight ? draft.highlight : draft.source.canvas}
                title={showHighlight ? "Original + highlightPaper()" : "Original image"}
              />
              <button className="btn mt-1 px-2 py-1 text-xs" onClick={toggleHighlight}>
                {showHighlight ? "Hide detection" : "Show raw detection (highlightPaper)"}
              </button>
            </div>
            {current ? (
              <ZoomCanvas canvas={current} title={`Scanned image — ${draft.filter}`} />
            ) : (
              <div className="flex min-h-40 items-center justify-center border border-dashed border-gray-400 text-sm text-gray-500">
                No scanned result
              </div>
            )}
          </div>

          {draft.cropped && (
            <div className="flex flex-wrap gap-2">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  className={draft.filter === f.id ? "btn-primary" : "btn"}
                  onClick={() => selectFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}

          <table className="w-full max-w-xl text-sm">
            <tbody className="[&_td]:border-b [&_td]:border-gray-300 [&_td]:py-1 [&_td:first-child]:pr-3 [&_td:first-child]:text-gray-600">
              <tr>
                <td>Capture</td>
                <td>
                  {draft.source.method}
                  {draft.source.note && <span className="block text-xs text-amber-700">{draft.source.note}</span>}
                </td>
              </tr>
              <tr>
                <td>Original resolution</td>
                <td>
                  {draft.source.canvas.width} × {draft.source.canvas.height} (
                  {((draft.source.canvas.width * draft.source.canvas.height) / 1e6).toFixed(1)} MP)
                </td>
              </tr>
              <tr>
                <td>Processed resolution</td>
                <td>{current ? `${current.width} × ${current.height}` : "—"}</td>
              </tr>
              <tr>
                <td>Crop</td>
                <td className={draft.cropSource === "none" ? "font-semibold text-red-700" : ""}>
                  {CROP_LABEL[draft.cropSource]}
                </td>
              </tr>
              <tr>
                <td>Filter</td>
                <td>{draft.filter}</td>
              </tr>
              <tr>
                <td>Capture time</td>
                <td>{ms(draft.stats.captureMs)}</td>
              </tr>
              <tr>
                <td>Detection time</td>
                <td>
                  {ms(draft.stats.detectMs)} <span className="text-xs text-gray-500">(on ≤{DETECT_MAX_SIDE}px copy)</span>
                </td>
              </tr>
              <tr>
                <td>Crop + perspective time</td>
                <td>{ms(draft.stats.extractMs)}</td>
              </tr>
              <tr>
                <td>Last filter time</td>
                <td>{ms(draft.stats.filterMs)}</td>
              </tr>
            </tbody>
          </table>

          <div className="flex flex-wrap gap-2">
            <button className="btn" onClick={() => setMode("crop")}>
              Adjust Crop
            </button>
            <button
              className="btn"
              onClick={() => {
                discardDraft();
                setMode("camera");
              }}
            >
              Retake
            </button>
            <button className="btn" onClick={downloadCurrentPng} disabled={!current}>
              Download PNG
            </button>
            <button className="btn-primary" onClick={() => savePage("pages")} disabled={!current}>
              Save Page
            </button>
            <button className="btn-primary" onClick={() => savePage("camera")} disabled={!current}>
              Save &amp; Add Another Page
            </button>
          </div>
        </section>
      )}

      {mode === "crop" && draft && (
        <CropEditor
          source={draft.source.canvas}
          initial={
            draft.corners ??
            draft.detected ??
            insetCorners(draft.source.canvas.width, draft.source.canvas.height)
          }
          onApply={(c) => recrop(c, "manual")}
          onCancel={() => setMode("preview")}
        />
      )}

      {(mode === "pages" || pages.length > 0) && mode !== "crop" && (
        <section className="flex flex-col gap-2 border-t border-gray-300 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="mr-auto font-semibold">Pages ({pages.length})</h2>
            {mode !== "camera" && (
              <button className="btn-primary" onClick={addPage}>
                Add Another Page
              </button>
            )}
            <button className="btn" onClick={downloadPdf} disabled={!pages.length}>
              Download PDF
            </button>
          </div>
          {pages.length === 0 && <p className="text-sm text-gray-500">No pages saved yet.</p>}
          <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {pages.map((p, i) => (
              <li
                key={p.id}
                className={`flex flex-col gap-1 rounded border bg-white p-1 text-xs ${
                  editIndex === i ? "border-blue-600" : "border-gray-300"
                }`}
              >
                <button onClick={() => openPage(i)} className="text-left">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.thumb} alt={`Page ${i + 1}`} className="mx-auto max-h-32 object-contain" />
                  <span className="block font-semibold">
                    {i + 1}. {p.filter} · {p.width}×{p.height}
                  </span>
                </button>
                <div className="flex flex-wrap gap-1">
                  <button className="btn px-1.5 py-0.5 text-xs" onClick={() => openPage(i)}>
                    View
                  </button>
                  <button className="btn px-1.5 py-0.5 text-xs" onClick={() => retakePage(i)}>
                    Retake
                  </button>
                  <button className="btn px-1.5 py-0.5 text-xs" onClick={() => download(p.output, `page-${i + 1}.jpg`)}>
                    Download
                  </button>
                  <button className="btn px-1.5 py-0.5 text-xs text-red-700" onClick={() => deletePage(i)}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
    </main>
  );
}
