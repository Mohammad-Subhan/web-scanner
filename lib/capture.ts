export type CaptureMethod = "ImageCapture.takePhoto" | "video frame (canvas)" | "upload";

export interface CaptureResult {
  /** Full-resolution, orientation-corrected pixels. */
  canvas: HTMLCanvasElement;
  /** Source bytes, kept so saved pages can be re-processed without re-encoding. */
  blob: Blob;
  method: CaptureMethod;
  note?: string;
}

export async function startCamera(): Promise<MediaStream> {
  if (!window.isSecureContext) {
    throw new Error("Camera requires HTTPS (or localhost). Open the app over https:// or use Upload.");
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not support camera access (getUserMedia). Use Upload instead.");
  }
  try {
    // Ask for a large stream; the browser picks the closest the camera supports.
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 4096 },
        height: { ideal: 2160 },
      },
    });
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === "NotAllowedError" || name === "SecurityError")
      throw new Error("Camera permission was denied. Allow camera access in browser settings, or use Upload.");
    if (name === "NotFoundError" || name === "OverconstrainedError")
      throw new Error("No usable camera was found. Use Upload instead.");
    if (name === "NotReadableError") throw new Error("The camera is in use by another app.");
    throw e;
  }
}

export function stopStream(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Decodes an image blob to a canvas, honouring EXIF orientation. */
export async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  try {
    const c = document.createElement("canvas");
    c.width = bitmap.width;
    c.height = bitmap.height;
    c.getContext("2d")!.drawImage(bitmap, 0, 0);
    return c;
  } finally {
    bitmap.close();
  }
}

export function canvasToBlob(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas encoding failed"))), type, quality),
  );
}

/**
 * High-resolution still capture. Uses ImageCapture.takePhoto() at the camera's maximum photo
 * resolution where supported (Chrome/Android), otherwise grabs a frame at the video's native size.
 */
export async function capturePhoto(stream: MediaStream, video: HTMLVideoElement): Promise<CaptureResult> {
  const track = stream.getVideoTracks()[0];
  let note: string | undefined;

  if (track && typeof ImageCapture !== "undefined") {
    try {
      const ic = new ImageCapture(track);
      const caps = await ic.getPhotoCapabilities();
      const settings =
        caps.imageWidth?.max && caps.imageHeight?.max
          ? { imageWidth: caps.imageWidth.max, imageHeight: caps.imageHeight.max }
          : undefined;
      const blob = await ic.takePhoto(settings);
      const canvas = await blobToCanvas(blob);
      return { canvas, blob, method: "ImageCapture.takePhoto" };
    } catch (e) {
      note = `takePhoto failed (${(e as Error).message}); used video frame`;
    }
  } else {
    note = "ImageCapture not supported; used video frame";
  }

  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) throw new Error("Camera is not ready yet");
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(video, 0, 0, w, h);
  // PNG keeps the frame lossless for later re-processing of saved pages.
  const blob = await canvasToBlob(canvas, "image/png");
  return { canvas, blob, method: "video frame (canvas)", note };
}
