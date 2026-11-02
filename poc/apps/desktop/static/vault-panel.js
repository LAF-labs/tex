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
    issued_on_uncertain: '발급일 라벨을 찾지 못해 위치로 추정함',
    read_by_ocr: '글자 층이 없어 OCR로 읽음',
    scanned_text_layer: '스캔 PDF에 덧입힌 글자로 읽음',
    expires_on_missing: '납세증명서 만료일이 비어 있음',
    issued_on_missing: '발급일이 비어 있음',
    expiry_recomputed: '만료일을 다시 계산함(확인해 주세요)',
    subject_mismatch: '대상 사업자번호가 내 사업장과 다름',
    subject_unverified: '대상 사업자번호를 읽지 못함',
  };
  const ERR = {
    profile_required: '내 사업장(사업자 프로필)을 먼저 저장하세요', not_pdf: 'PDF 파일이 아닙니다', input_size: '파일이 비었거나 15MB를 넘습니다', read_failed: '파일을 읽지 못했습니다',
    invalid_pdf: 'PDF를 열 수 없습니다(손상)', timeout: '읽는 데 너무 오래 걸려 멈췄습니다', memory_limit: '메모리 상한을 넘어 멈췄습니다', pick_expired: '파일을 다시 고르세요', password_too_long: '암호가 너무 깁니다',
    issued_in_future: '발급일이 오늘보다 뒤입니다', expires_before_issued: '만료일이 발급일보다 앞입니다', expires_after_legal_max: '납세증명서 유효기간은 발급일부터 30일을 넘을 수 없습니다',
    invalid_issued_on: '발급일 형식이 아닙니다', invalid_expires_on: '만료일 형식이 아닙니다',
    stale: '그사이 서류가 바뀌었습니다. 목록을 다시 읽었으니 다시 확인하세요', seen_required: '요청을 처리하지 못했습니다',
  };
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
      const status = d.needsUser ? `확인 필요: ${d.reasons.map((r) => REASON[r] || r).join(', ') || '값 확인'}` : d.subjectMismatch ? '다른 사업자 서류(확인함)' : '';
      tr.append(
        cell(d.displayName),
        cell(d.issuedOn || '—'),
        cell(d.expiresOn ? `${d.expiresOn} · ${dday(d.daysLeft)}` : '—', d.daysLeft !== null && d.daysLeft <= 7 ? 'err' : ''),
        // 확인 필요인 값은 출처와 상관없이 추정(정하지 못한 유효기간의 문서 후보 등)
        cell(d.expiresOn ? (d.needsUser ? '추정(확인 필요)' : SOURCE[d.expirySource] || '') : ''),
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
    // 정하지 못한 칸의 후보는 값 칸에 넣지 않고 보여만 준다. 사용자가 PDF를 보고 '후보 넣기'를 누르거나 직접 입력한다.
    // 후보는 칸이 규칙 날짜로 차 있어도 보여 준다(유효기간 후보가 여럿이면 엔진은 규칙 날짜를 두고 문서의 가장 이른 후보를 따로 준다)
    const hints = [];
    if (d.suggested.issuedOn && d.suggested.issuedOn !== d.issuedOn) hints.push(`발급일 후보 ${d.suggested.issuedOn}`);
    if (d.suggested.validUntil && d.suggested.validUntil !== d.expiresOn) hints.push(`문서 유효기간 후보 ${d.suggested.validUntil}`);
    $('#v-edit-hint').textContent = hints.length ? `${hints.join(' · ')} (PDF에서 확인하세요)` : '';
    $('#v-edit-use').hidden = !hints.length;
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
      const how = r.parse.ocrConfidence !== null ? `OCR(신뢰도 ${r.parse.ocrConfidence})` : r.parse.scanned ? '스캔 글자 층' : '텍스트';
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
    call('vault.importCancel', { pickId }).catch(() => {});
    pickId = null;
    say('');
  };
  $('#v-edit').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = $('#v-edit');
    const submit = f.querySelector('[type=submit]');
    if (submit?.disabled) return; // 응답을 기다리는 중(같은 요청을 두 번 보내지 않게)
    // 입력하다 만 날짜는 값이 ''라 그대로 보내면 날짜를 지우는 요청이 된다
    if (f.issuedOn.validity.badInput || f.expiresOn.validity.badInput) return (f.querySelector('.msg').textContent = '날짜를 끝까지 넣어 주세요');
    // 바뀐 칸만 보낸다. 종류·발급일만 바꾸면 엔진이 만료일을 규칙으로 다시 정하고, 아무것도 안 바꾸면 지금 값을 확인한 것이다.
    // 보여 준 값(seen)을 붙인다. 그사이 저장값이 바뀌었으면 엔진이 stale로 거부한다.
    const patch = {};
    if (f.docType.value !== editing.docType) patch.docType = f.docType.value;
    if ((f.issuedOn.value || null) !== editing.issuedOn) patch.issuedOn = f.issuedOn.value || null;
    if ((f.expiresOn.value || null) !== editing.expiresOn) patch.expiresOn = f.expiresOn.value || null;
    const seen = { docType: editing.docType, issuedOn: editing.issuedOn, expiresOn: editing.expiresOn };
    if (submit) submit.disabled = true;
    try {
      await call('document.update', { id: editing.id, patch, seen });
      f.hidden = true;
      load();
    } catch (err) {
      // 다른 곳에서 바뀐 서류: 편집 줄을 닫고 목록을 다시 읽는다(옛 값으로 계속 보내지 않게)
      if (String(err?.message).includes('stale')) {
        f.hidden = true;
        say(errText(err), 'err');
        load();
      } else f.querySelector('.msg').textContent = errText(err);
    } finally {
      if (submit) submit.disabled = false;
    }
  });
  $('#v-edit-cancel').onclick = () => ($('#v-edit').hidden = true);
  $('#v-edit-use').onclick = () => {
    const f = $('#v-edit');
    if (editing.suggested.issuedOn) f.issuedOn.value = editing.suggested.issuedOn;
    if (editing.suggested.validUntil) f.expiresOn.value = editing.suggested.validUntil;
  };
  load();
})();
