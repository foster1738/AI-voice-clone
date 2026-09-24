// Copies the ONNX Runtime Web build into app/vendor/ort so the AI engine works
// offline (desktop and mobile builds). The web version falls back to the CDN.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../node_modules/onnxruntime-web/dist/', import.meta.url));
const dst = fileURLToPath(new URL('../app/vendor/ort/', import.meta.url));
if (!existsSync(src)) {
  console.error('onnxruntime-web is not installed. Run `npm install` first.');
  process.exit(1);
}
mkdirSync(dst, { recursive: true });
for (const f of ['ort.all.min.mjs', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  cpSync(src + f, dst + f);
  console.log('vendored', f);
}
