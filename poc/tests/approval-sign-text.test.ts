// 승인 카드 비가역 한 줄(U3): 승인만으로는 발급되지 않는다. 발급 인증별로 승인 뒤 사람 몫을 말하고, 대화 열(600px) 카드에 들어간다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildGateRequest } from '@sax/engine/gate';
import { gateText, irreversibleText, overflowLine, SIGN_AFTER, summarize, type SummaryLine } from '../apps/desktop/src/approval-gate.ts';
import { SIGN_LABEL } from '../apps/desktop/src/shell-model.ts';
import { NOTE } from '../apps/desktop/src/shell-runs.ts';

const readback = {
  supplierBizNo: '1234567891', supplierName: '가나다컴퍼니', counterpartBizNo: '2148651233', counterpartName: 'A상사', counterpartEmail: 'tax@asangsa.example',
  itemName: '경영 컨설팅', itemCount: '1', supplyAmount: '3000000', taxAmount: '300000', totalAmount: '3300000', issueDate: '2026-11-12', remark: '', receiptType: '청구',
};

describe('승인 카드: 발급 인증별 비가역 한 줄', () => {
  it('세 발급 인증 + 모름: "바로 발급"이라 하지 않고 승인 뒤 할 일을 말한다. 600px 카드에 들어간다', () => {
    assert.deepEqual(Object.keys(SIGN_AFTER).sort(), Object.values(SIGN_LABEL).sort());
    const req = buildGateRequest({ runId: 'r', gateStepId: 's20', readback, reserved: [{ fieldKey: '$first.bizNo', value: 'false' }, { fieldKey: '$first.email', value: 'false' }], packageDigest: '0'.repeat(64), authorizes: ['s21'], intentId: 'i', waitMs: 1000 });
    const lines = summarize(req, '2026-11-12') as SummaryLine[];
    assert.ok(Array.isArray(lines));
    for (const auth of [...Object.values(SIGN_LABEL), '발급 인증 미설정']) {
      for (const mail of [true, false]) {
        const t = gateText('승인하고 발급', 'A상사', mail, auth);
        assert.equal(t.irreversible, irreversibleText(auth, mail));
        assert.ok(!/바로 발급/.test(t.irreversible) && /^승인 뒤 .+ 발급.*돼요\. 되돌릴 수 없어요\.$/.test(t.irreversible), t.irreversible);
        assert.equal(/메일/.test(t.irreversible), mail, t.irreversible);
        assert.equal(overflowLine(lines, 600, t), null, `${auth} ${mail}: ${t.irreversible}`);
      }
    }
    assert.match(irreversibleText(SIGN_LABEL.cert, true), /인증서 비밀번호/);
    assert.match(irreversibleText(SIGN_LABEL.simple_auth, true), /휴대폰 간편인증/);
    assert.match(irreversibleText(SIGN_LABEL.security_card, true), /보안카드 번호/);
  });

  it('인증서 비밀번호 틀림·잠김 문구: 승인 뒤 코드라 "아무것도 발급하지 않았어요"·[다시 준비]를 말하지 않는다', () => {
    for (const c of ['sign.password_wrong', 'sign.password_retry_limit']) {
      assert.ok(NOTE[c], c);
      assert.ok(!/아무것도 발급하지 않았어요|\[다시 준비\]/.test(NOTE[c]!), c);
    }
  });
});
