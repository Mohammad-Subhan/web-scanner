/* eslint-disable @typescript-eslint/no-explicit-any */

// OpenCV.js exposes a huge untyped global; jscanify relies on it being `window.cv`.
declare global {
  interface Window {
    cv: any;
  }

  // ImageCapture is not in TypeScript's DOM lib (Chromium-only API).
  interface PhotoCapabilities {
    imageWidth?: { min: number; max: number; step: number };
    imageHeight?: { min: number; max: number; step: number };
  }
  class ImageCapture {
    constructor(track: MediaStreamTrack);
    takePhoto(settings?: { imageWidth?: number; imageHeight?: number }): Promise<Blob>;
    getPhotoCapabilities(): Promise<PhotoCapabilities>;
  }
}

export {};
