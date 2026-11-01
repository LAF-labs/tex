// 개발 콘솔 보관함 구역(PoC-8): 목록·만료 표시·가져오기·확인. 값은 textContent로만 넣는다.
(() => {
  const $ = (s) => document.querySelector(s);
  const call = (m, p) => window.sax.call(m, p);
  const SOURCE = { document: '문서에서 읽음', rule: '추정(규칙표)', user: '확인함' };
  const REASON = {
    doc_type_unknown: '서류 종류를 알아보지 못함',
    issued_on_not_found: '발급일을 찾지 못함',
    issued_on_ambiguous: '발급일 후보가 여러 개',
    issued_on_unparseable: '발급일을 읽지 못함',
    issued_on_out_of_range: '발급일이 오늘 뒤이거나 너무 이름',
    valid_until_not_found: '유효기간을 찾지 못함(규칙표로 추정)',
    valid_until_ambiguous: '유효기간 후보가 여러 개',
    valid_until_unparseable: '유효기간을 읽지 못함',
    valid_until_out_of_range: '유효기간이 발급일~30일 밖',
    read_by_ocr: '글자 층이 없어 OCR로 읽음',
  };
  const ERR = { profile_required: '내 사업장(사업자 프로필)을 먼저 저장하세요', not_pdf: 'PDF 파일이 아닙니다', input_size: '파일이 비었거나 15MB를 넘습니다', invalid_pdf: 'PDF를 열 수 없습니다(손상)', timeout: '읽는 데 너무 오래 걸려 멈췄습니다', memory_limit: '메모리 상한을 넘어 멈췄습니다', pick_expired: '파일을 다시 고르세요' };
  const errText = (e) => {
    const m = String((e && e.message) || e);
    const k = Object.keys(ERR).find((c) => m.includes(c));
    return k ? ERR[k] : m.replace(/^Error invoking remote method 'sax': (Error: )?/, '');
  };
  const say = (text, cls) => {
    const el = $('#v-msg');
    el.textContent = text;
    el.className = 'msg ' + (cls || '');
  };
  const dday = (n) => (n === null ? '' : n < 0 ? '만료됨' : n === 0 ? 'D-day' : `D-${n}`);
  let pickId = null;
  let editing = null;

  function cell(text, cls) {
    const td = document.createElement('td');
    td.textContent = text;
    if (cls) td.className = cls;
    return td;
  }

  async function load() {
    const list = await call('db.query.documents.list').catch(() => []);
    const body = $('#v-list');
    body.replaceChildren();
    for (const d of list) {
      const tr = document.createElement('tr');
      const status = d.needsUser ? `확인 필요: ${d.reasons.map((r) => REASON[r] || r).join(', ') || '값 확인'}` : d.subjectMismatch ? '다른 사업자 서류' : '';
      tr.append(
        cell(d.displayName),
        cell(d.issuedOn || '—'),
        cell(d.expiresOn ? `${d.expiresOn} · ${dday(d.daysLeft)}` : '—', d.daysLeft !== null && d.daysLeft <= 7 ? 'err' : ''),
        cell(d.expiresOn ? SOURCE[d.expirySource] || '' : ''),
        cell(d.docNo || '—'),
        cell(status, d.needsUser || d.subjectMismatch ? 'err' : ''),
      );
      const td = document.createElement('td');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = d.needsUser || d.expirySource === 'rule' ? '확인' : '수정';
      b.onclick = () => openEdit(d);
      td.append(b);
      tr.append(td);
      body.append(tr);
    }
  }

  function openEdit(d) {
    editing = d;
    const f = $('#v-edit');
    $('#v-edit-name').textContent = d.displayName;
    f.docType.value = d.docType;
    f.issuedOn.value = d.issuedOn || '';
    f.expiresOn.value = d.expiresOn || '';
    f.querySelector('.msg').textContent = '';
    f.hidden = false;
  }

  async function importPdf(extra) {
    say('읽는 중…');
    try {
      const r = await call('vault.importPdf', extra || {});
      if (!r) return say('');
      if (r.status === 'needs_password' || r.status === 'wrong_password') {
        pickId = r.pickId;
        $('#v-password').hidden = false;
        $('#v-password').password.value = '';
        return say(r.status === 'needs_password' ? '열기 암호가 걸린 PDF입니다. 암호를 넣으세요.' : '암호가 맞지 않습니다.', 'err');
      }
      const d = r.document;
      const how = r.parse.hasTextLayer ? '텍스트' : `OCR(신뢰도 ${r.parse.ocrConfidence})`;
      say(`${d.duplicate ? '이미 있는 파일입니다' : '보관함에 넣었습니다'} · ${d.displayName} · ${how} · ${r.parse.ms}ms`, d.needsUser ? 'err' : 'ok');
      load();
    } catch (e) {
      say(errText(e), 'err');
    }
  }

  $('#v-import').onclick = () => importPdf();
  $('#v-password').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = $('#v-password');
    const password = f.password.value;
    f.password.value = '';
    f.hidden = true;
    importPdf({ pickId, password });
    pickId = null;
  });
  $('#v-password-cancel').onclick = () => {
    $('#v-password').hidden = true;
    pickId = null;
    say('');
  };
  $('#v-edit').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = $('#v-edit');
    const patch = { docType: f.docType.value, issuedOn: f.issuedOn.value || null, expiresOn: f.expiresOn.value || null };
    try {
      await call('document.update', { id: editing.id, patch });
      f.hidden = true;
      load();
    } catch (err) {
      f.querySelector('.msg').textContent = errText(err);
    }
  });
  $('#v-edit-cancel').onclick = () => ($('#v-edit').hidden = true);
  load();
})();
