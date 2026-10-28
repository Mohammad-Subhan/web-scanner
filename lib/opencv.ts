// Loads /opencv.js once and resolves when the WASM runtime is ready.
// Note: OpenCV.js builds expose `cv` either as a real Promise (newer builds) or as an
// Emscripten Module with a `then` method (4.9 here). Awaiting the latter can loop forever,
// so we wait for `cv.Mat` to appear instead of awaiting `cv`.
let loading: Promise<void> | null = null;

const TIMEOUT_MS = 90_000;

export function loadOpenCV(): Promise<void> {
  if (loading) return loading;

  loading = new Promise<void>((resolve, reject) => {
    const waitForRuntime = () => {
      const started = Date.now();
      if (window.cv instanceof Promise) {
        window.cv.then((mod: unknown) => {
          window.cv = mod;
        });
      }
      const poll = () => {
        if (window.cv && window.cv.Mat) return resolve();
        if (Date.now() - started > TIMEOUT_MS) return reject(new Error("OpenCV.js initialization timed out"));
        setTimeout(poll, 50);
      };
      poll();
    };

    if (window.cv) {
      waitForRuntime();
      return;
    }
    const script = document.createElement("script");
    script.src = "/opencv.js";
    script.async = true;
    script.onload = waitForRuntime;
    script.onerror = () => reject(new Error("Failed to download /opencv.js"));
    document.body.appendChild(script);
  });

  loading.catch(() => {
    loading = null; // allow retry
  });
  return loading;
}
