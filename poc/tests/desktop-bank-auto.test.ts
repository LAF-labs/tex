// 계좌 자동조회(CODEF) main 쪽: 비밀번호 창 결속 검사·창 페이지·화면 요청 → 엔진 codef.* (Electron 없이)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bankAutoHandlers, codefPageHtml, parseCodefNeeded } from '../apps/desktop/src/bank-auto.ts';
import { SHELL_METHODS, USER_ACTION_METHODS, parseRendererRequest } from '../apps/desktop/src/ipc.ts';

const REQ = 'a'.repeat(32);

describe('계좌 자동조회 main', () => {
  it('금고 secret.needed{mode:codef}만 비밀번호 창으로 연다', () => {
    assert.deepEqual(parseCodefNeeded({ mode: 'codef', reqId: REQ, scope: 'business' }), { mode: 'codef', reqId: REQ, scope: 'business' });
    for (const bad of [null, { mode: 'oneshot', reqId: REQ, scope: 'business' }, { mode: 'codef', reqId: 'x', scope: 'business' }, { mode: 'codef', reqId: REQ, scope: 'other' }]) assert.equal(parseCodefNeeded(bad), null);
  });

  it('창 페이지는 결속값만 싣고 글자는 이스케이프한다', () => {
    const html = codefPageHtml({ mode: 'codef', reqId: REQ, scope: 'business' }, { profileName: '<가나>상사', certLabel: '홍길동 · yessign' });
    assert.ok(html.includes(`data-req="${REQ}"`) && html.includes('data-scope="business"'));
    assert.ok(html.includes('&lt;가나&gt;상사') && !html.includes('<가나>'));
    assert.ok(html.includes('codef-secret.js') && html.includes('id="remember"'));
  });

  it('화면 요청 표: 비밀번호 칸이 없고, 연결·고르기·최신화·해제는 실제 입력 뒤에만', () => {
    for (const m of ['bankAuto.connect', 'bankAuto.choose', 'bankAuto.refresh', 'bankAuto.disconnect'] as const) assert.equal(USER_ACTION_METHODS[m], 3_000);
    assert.throws(() => parseRendererRequest(SHELL_METHODS, { method: 'bankAuto.connect', params: { certId: 'x', password: 'p' } }), /bad_request/);
    assert.throws(() => parseRendererRequest(SHELL_METHODS, { method: 'bankAuto.connect', params: { certId: 'x', bank: '9999' } }), /bad_request/);
  });

  it('연결은 고를 수 있는 인증서만 엔진으로 넘기고, 인증서 행은 이름·용도·만료일만', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const certs = [
      { id: '0123456789abcdef', owner: '홍길동', usage: 'yessign', expiresOn: '2027-01-01', usable: true },
      { id: 'fedcba9876543210', owner: '김철수', usage: 'KICA', expiresOn: '2025-01-01', usable: false, why: 'expired' as const },
    ];
    const b = bankAutoHandlers({ engine: async (m, p) => (calls.push([m, p]), { ok: true }), certs: async () => certs });
    const list = (await b.handlers['bankAuto.certs']()) as { certs: object[] };
    assert.deepEqual(Object.keys(list.certs[0]!).sort(), ['expiresOn', 'id', 'owner', 'usable', 'usage']);
    assert.deepEqual(await b.handlers['bankAuto.connect']({ certId: 'fedcba9876543210' }), { ok: false, code: 'cert_missing' });
    await b.handlers['bankAuto.connect']({ certId: '0123456789abcdef', bank: '0020' });
    assert.deepEqual(calls, [['codef.connect', { certId: '0123456789abcdef', bank: '0020', clientType: 'B' }]]);
    assert.equal(b.chosenLabel(), '홍길동 · yessign');
  });
});
