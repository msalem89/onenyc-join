# Self-hosted Tesseract.js (v5.1.1) for join.onenyc.org

Loaded lazily only when a visitor uploads a scanned PDF or image.
No CDN. No third-party OCR API. Document bytes never leave the browser.

Assets:
- tesseract.min.js + worker.min.js
- tesseract-core-simd-lstm.wasm(.js) — modern browsers
- tesseract-core-lstm.wasm(.js) — non-SIMD fallback
- eng.traineddata.gz — English (best_int, ~2.8 MB gzipped)

Do not delete. Live site needs these next to index.html under vendor/tesseract/.
