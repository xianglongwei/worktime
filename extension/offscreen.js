// 离屏文档：接收 background 发来的验证码图片（dataURL），在本地用
// Tesseract.js 离线识别，返回识别文本。识别前先做二值化去噪预处理，
// 大幅提升这种“黑色字符 + 轻噪点”验证码的识别率。
// 数据全程不出本机，不联网。

const CHAR_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const BINARY_THRESHOLD = 140; // 低于此灰度判为黑，滤掉浅灰噪点
const UPSCALE = 3;            // 放大后识别更稳

let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker("eng", 1, {
      workerPath: chrome.runtime.getURL("vendor/tesseract/worker.min.js"),
      corePath: chrome.runtime.getURL("vendor/tesseract/tesseract-core-simd-lstm.wasm.js"),
      langPath: chrome.runtime.getURL("vendor/tesseract/"),
      workerBlobURL: false,
      gzip: true
    }).then(async (worker) => {
      await worker.setParameters({
        tessedit_char_whitelist: CHAR_WHITELIST,
        tessedit_pageseg_mode: "8" // 整张图当作单个词
      });
      return worker;
    });
  }
  return workerPromise;
}

// 灰度二值化 + 放大，返回处理后的 PNG dataURL
async function preprocess(dataUrl) {
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("验证码图片加载失败"));
    img.src = dataUrl;
  });

  const canvas = document.createElement("canvas");
  canvas.width = (img.width || 105) * UPSCALE;
  canvas.height = (img.height || 35) * UPSCALE;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = gray < BINARY_THRESHOLD ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "OCR_CAPTCHA" && message.target === "offscreen") {
    (async () => {
      try {
        const pre = await preprocess(message.dataUrl);
        const worker = await getWorker();
        const { data } = await worker.recognize(pre);
        const text = (data?.text || "").replace(/[^A-Za-z0-9]/g, "");
        sendResponse({ ok: true, text });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
    return true;
  }

  return false;
});
