// 렌더러: 표시만. 데이터 값은 textContent로만 넣는다. 네트워크 없음(CSP connect-src 'none').
const $ = (s) => document.querySelector(s);
const call = (m, p) => window.sax.call(m, p);
const say = (el, text, cls) => { el.textContent = text; el.className = 'msg ' + (cls || ''); };
const fmtBiz = (d) => (d && d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : d || '');
const ERR = { invalid_biz_no: '사업자등록번호가 올바르지 않습니다', duplicate_biz_no: '이미 있는 거래처입니다', invalid_email: '이메일 형식이 아닙니다', no_key: '진위확인 키를 먼저 설정하세요', unauthorized: '키가 거부되었습니다', rep_name_required: '대표자 이름이 필요합니다', display_name_required: '표시 이름이 필요합니다', name_required: '상호가 필요합니다' };
const errText = (e) => { const m = String(e && e.message || e); const k = Object.keys(ERR).find((c) => m.includes(c)); return k ? ERR[k] : m.replace(/^Error invoking remote method 'sax': (Error: )?/, ''); };
const formData = (f) => Object.fromEntries([...new FormData(f).entries()].map(([k, v]) => [k, String(v).trim() || null]));

async function refreshStatus() {
  const s = await call('app.status').catch(() => null);
  $('#status').textContent = s ? `DB ${s.engine?.db ? '열림' : '대기'} · 브라우저 ${s.engine?.browser ? '실행 중' : '꺼짐'} · 진위확인 키 ${s.hasKey ? '있음' : '없음'}` : '엔진 대기';
}

async function loadProfiles() {
  for (const p of await call('db.query.profiles.list')) {
    const f = $(`#pf-${p.kind}`);
    for (const el of f.elements) if (el.name && p[el.name] != null) el.value = el.name === 'bizNo' ? fmtBiz(p[el.name]) : p[el.name];
  }
}
for (const f of document.querySelectorAll('form[data-kind]')) {
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = f.querySelector('.msg');
    try {
      await call('profile.upsert', { ...formData(f), kind: f.dataset.kind });
      say(msg, '저장됨', 'ok');
    } catch (err) { say(msg, errText(err), 'err'); }
  });
}

async function loadCounterparties() {
  const rows = await call('db.query.counterparties.list', { q: $('#cp-q').value });
  const tb = $('#cp-table tbody');
  tb.replaceChildren();
  for (const c of rows) {
    const tr = document.createElement('tr');
    for (const v of [c.name, fmtBiz(c.bizNo), c.repName, c.email, c.verifiedStatus ? `${c.verifiedStatus} (${(c.verifiedAt || '').slice(0, 10)})` : '-', c.source]) {
      const td = document.createElement('td'); td.textContent = v || ''; tr.append(td);
    }
    const td = document.createElement('td');
    const btn = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = fn; td.append(b, ' '); };
    btn('수정', () => editCp(c));
    btn('상태조회', async () => { try { await call('counterparty.status', { id: c.id }); } catch (e) { alert(errText(e)); } loadCounterparties(); });
    btn('진위확인', async () => {
      const sd = prompt('개업일자(YYYYMMDD)'); if (!sd) return;
      try { const r = await call('counterparty.verify', { id: c.id, startDate: sd }); alert(r.result.valid ? '일치' : `불일치: ${r.result.message || ''}`); } catch (e) { alert(errText(e)); }
      loadCounterparties();
    });
    btn('삭제', async () => { if (confirm(`${c.name} 삭제?`)) { await call('counterparty.delete', { id: c.id }); loadCounterparties(); } });
    tr.append(td); tb.append(tr);
  }
}
$('#cp-q').addEventListener('input', () => loadCounterparties());

function editCp(c) {
  const f = $('#cp-form'); f.reset();
  $('#cp-form-title').textContent = c ? '거래처 수정' : '거래처 추가';
  for (const el of f.elements) if (el.name && c && c[el.name] != null) el.value = el.name === 'bizNo' ? fmtBiz(c[el.name]) : c[el.name];
  f.elements.bizNo.readOnly = !!c; f.elements.id.value = c ? c.id : ''; $('#cp-ocr-note').textContent = '';
}
$('#cp-reset').onclick = () => editCp(null);
$('#cp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target; const d = formData(f); const msg = f.querySelector('.msg');
  try {
    if (d.id) await call('counterparty.update', { id: d.id, patch: { name: d.name, repName: d.repName, address: d.address, email: d.email } });
    else await call('counterparty.create', { bizNo: d.bizNo, name: d.name, repName: d.repName, address: d.address, email: d.email, source: d.source || 'manual' });
    say(msg, '저장됨', 'ok'); editCp(null); loadCounterparties();
  } catch (err) { say(msg, errText(err), 'err'); }
});

$('#cp-ocr').onclick = async () => {
  const note = $('#cp-ocr-note');
  note.textContent = '샌드박스에서 인식 중…';
  try {
    const r = await call('ocr.bizcert');
    if (!r) { note.textContent = ''; return; }
    editCp(null);
    const f = $('#cp-form'); const p = r.parse.fields;
    f.elements.name.value = p.name || ''; f.elements.bizNo.value = fmtBiz(p.bizNo || ''); f.elements.repName.value = p.repName || '';
    f.elements.address.value = p.address || ''; f.elements.startDate.value = p.openDate || ''; f.elements.source.value = 'ocr';
    const warn = [];
    if (!r.parse.bizNoChecksumOk) warn.push(`등록번호 확인 필요${r.parse.bizNoSuggestions.length ? ` (후보: ${r.parse.bizNoSuggestions.map(fmtBiz).join(', ')})` : ''}`);
    if (r.parse.missing.length) warn.push(`못 읽은 항목: ${r.parse.missing.join(', ')}`);
    note.textContent = `인식 신뢰도 ${Math.round(r.confidence)} · ${r.ms}ms. 값을 확인한 뒤 저장하세요. ${warn.join(' / ')}`;
  } catch (e) { note.textContent = errText(e); }
};

$('#key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const el = e.target.elements.key; const msg = e.target.querySelector('.msg');
  const r = await call('bizverify.setKey', { key: el.value }); el.value = '';
  say(msg, r.hasKey ? '설정됨(메모리만)' : '지움', 'ok'); refreshStatus();
});

const bmsg = (t) => { $('#b-msg').textContent = t; };
$('#b-open').onclick = async () => { try { await call('browser.open', { portal: 'hometax' }); bmsg('전용 Chrome을 열었습니다(파이프 전용, 포트 없음).'); } catch (e) { bmsg(errText(e)); } refreshStatus(); };
$('#b-close').onclick = async () => { await call('browser.close'); bmsg('닫았습니다.'); refreshStatus(); };
$('#b-secret').onclick = () => call('secret.openInput', { kind: 'cert_password', scope: 'business' });
$('#b-approval').onclick = async () => {
  bmsg('창 아래에 승인 바를 띄웠습니다. 바가 뜬 뒤 0.6초 동안과 마우스를 움직인 직후 0.15초 동안의 클릭은 무시합니다. 키보드로는 승인되지 않습니다.');
  const r = await call('approval.demo');
  bmsg(`승인 바 결과: ${r.decision}${r.verified ? ' · LocalApproval 검증됨' : ''}`);
};

loadProfiles(); loadCounterparties(); refreshStatus(); setInterval(refreshStatus, 3000);
