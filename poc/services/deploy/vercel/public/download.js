/* global document */ // 브라우저에서 도는 다운로드 페이지 스크립트(#375). 린트는 node 전역으로 본다.
(async () => {
  const out = document.getElementById('release');
  const parts = [];
  const show = () => { out.textContent = parts.join(' · '); };
  try {
    const r = await fetch('/releases/beta/latest.json', { cache: 'no-store' });
    if (!r.ok) return;
    const m = await r.json();
    if (/^\d+\.\d+\.\d+$/.test(m.version)) parts.push(`최신 판 ${m.version}`);
    const d = new Date(m.releaseDate);
    if (!Number.isNaN(d.getTime())) parts.push(new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'long' }).format(d));
    show();
    const zip = m.files?.[0]?.url;
    if (typeof zip !== 'string' || !/^https:\/\/[^/]+\/.+\.zip$/.test(zip)) return;
    const h = await fetch(zip.replace(/\.zip$/, '.dmg'), { method: 'HEAD' });
    const bytes = Number(h.headers.get('content-length'));
    if (h.ok && bytes > 0) parts.push(`${(bytes / 1e6).toFixed(1)}MB`);
    show();
  } catch {
    show();
  }
})();
