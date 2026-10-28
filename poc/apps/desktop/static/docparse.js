// 샌드박스 안 OCR. 입력 바이트 → {text, confidence}. 네트워크 없음, 저장 없음(cacheMethod none).
window.addEventListener('message', (ev) => {
  if (ev.data !== 'docparse-port' || !ev.ports[0]) return;
  const port = ev.ports[0];
  port.onmessage = async ({ data }) => {
    let worker;
    try {
      worker = await Tesseract.createWorker('kor', 1, {
        workerPath: 'sax-docparse://app/worker.min.js',
        corePath: 'sax-docparse://app/core',
        langPath: 'sax-docparse://app/lang',
        workerBlobURL: false,
        cacheMethod: 'none',
        gzip: true,
      });
      const { data: r } = await worker.recognize(new Blob([data.bytes]));
      port.postMessage({ text: String(r.text || ''), confidence: Number(r.confidence || 0) });
    } catch (e) {
      port.postMessage({ error: String((e && e.message) || e).slice(0, 120) });
    } finally {
      if (worker) await worker.terminate();
    }
  };
});
