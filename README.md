# Check8 Web Scanner (test app)

Browser-based document scanning proof of concept (Next.js + jscanify + OpenCV.js). It is used to compare scan quality with the Android ML Kit Document Scanner. All processing runs locally in the browser.

## Run

```bash
npm install
npm run dev          # desktop: http://localhost:3000 (camera works on localhost)
npm run dev:https    # phone: https://<your-PC-LAN-IP>:3000 (self-signed cert, accept the warning)
```

The camera requires a secure context, so phones must use `dev:https`. Your PC and phone must be on the same network, and the Windows firewall must allow Node on port 3000.

Production check: `npm run build && npm start`.

## How it works

| Step | Implementation |
| --- | --- |
| Live outline | jscanify `findPaperContour` + `getCornerPoints` on a 320 px frame, ~3×/s (`components/CameraView.tsx`) |
| Capture | `ImageCapture.takePhoto()` at max photo resolution; falls back to a native-size video frame (`lib/capture.ts`) |
| Detection | jscanify on a ≤1600 px copy of the full capture, corners scaled back; implausible quads are rejected (`lib/scanner.ts`) |
| Crop + perspective | jscanify `extractPaper` on the full-res image; output size from the document's edge lengths (≤4000 px) |
| Raw detection view | jscanify `highlightPaper` ("Show raw detection" under the original) |
| Filters | OpenCV.js: grayscale, adaptive-threshold B&W, background-division "Enhanced" (`lib/filters.ts`) |
| PDF | jsPDF, JPEG bytes embedded without re-compression |

`public/opencv.js` is OpenCV.js 4.9.0, self-hosted.
