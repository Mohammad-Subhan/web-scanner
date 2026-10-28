/* eslint-disable @typescript-eslint/no-explicit-any */
// Types for jscanify's browser build (node_modules/jscanify/src/jscanify.js, v1.4.x).
declare module "jscanify/client" {
  export interface Point {
    x: number;
    y: number;
  }
  export interface CornerPoints {
    topLeftCorner?: Point;
    topRightCorner?: Point;
    bottomLeftCorner?: Point;
    bottomRightCorner?: Point;
  }
  export default class jscanify {
    /** Takes a cv.Mat; returns the largest contour (cv.Mat) or null. Caller must delete it. */
    findPaperContour(img: any): any | null;
    getCornerPoints(contour: any): CornerPoints;
    highlightPaper(
      image: HTMLCanvasElement | HTMLImageElement,
      options?: { color?: string; thickness?: number },
    ): HTMLCanvasElement;
    extractPaper(
      image: HTMLCanvasElement | HTMLImageElement,
      resultWidth: number,
      resultHeight: number,
      cornerPoints?: CornerPoints,
    ): HTMLCanvasElement | null;
  }
}
