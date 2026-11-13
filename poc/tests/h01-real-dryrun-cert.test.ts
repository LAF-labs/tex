// H-01 실화면 패키지(2.2.0) + 공동인증서 비밀번호 포트(CertSecretPort, engine-cert B1·B2): 가짜 홈택스(tests/hometax-fake.ts) 건조 실행. 실제 홈택스에 접속하지 않는다.
// 실화면 인증서 창은 홈택스 페이지 안의 iframe#dscert(MagicLine4)다. #309부터 사전 칸이 그 iframe을 가리키면 금고가 그 칸을 맡는다(한 번 묻는다).
// 금고가 칸을 못 찾으면(not_found) 사람이 홈택스 창에서 직접 넣는 길(서명 차례 handoff sign + doneTarget 감시)로 간다. 금고는 가짜(부른 RPC만 적고 not_found).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SecretVault } from '@sax/engine';
import type { PackageFiles } from '@sax/engine/core';
import { realDryRun, type Outcome } from './h01-real-dryrun.ts';

class FakeVault implements SecretVault {
  calls: string[] = [];
  async rpc<T>(m: string): Promise<T> {
    this.calls.push(m);
    return { ok: false, reason: 'not_found' } as T;
  }
  on() {
    return () => {};
  }
}

const show = (o: Outcome) => `end=${JSON.stringify(o.end)} steps=${o.steps.join(' ')} journal=${o.journal.join(',')}`;
const commits = (o: Outcome) => o.actions.filter((a) => /^ATEETBAA002C0[458]$/.test(a));
/** s21 signFlow 공동인증서 동작에 human:secret을 넣은 판(금고 비밀 창을 쓰려는 패키지 가정). */
const withSecret = (files: PackageFiles) => {
  const s21 = files.playbook.steps.find((s) => s.id === 's21') as { signFlow: { steps: Record<string, string[]> } };
  s21.signFlow.steps.cert = ['human:secret'];
};

describe('H-01 실화면 패키지 + 공동인증서 비밀번호 포트(B1·B2)', () => {
  it('게시본 그대로: 금고에 인증서 창 칸을 한 번 묻고, 못 찾으면(not_found) 사람이 인증서 창에서 직접 → 서명 차례 → success', async () => {
    const vault = new FakeVault();
    const o = await realDryRun({ loggedIn: true, secret: { vault, targetId: () => 'T1' } });
    assert.equal(o.end?.status, 'success', show(o));
    assert.deepEqual(vault.calls, ['secretWindow.openForHuman'], '금고에 한 번만 묻는다(값은 엔진에 오지 않는다)');
    const at = (t: string) => o.journal.indexOf(t);
    assert.ok(at('human.secret_manual') >= 0 && at('sign.turn_opened') > at('human.secret_manual'), show(o));
    assert.deepEqual(commits(o), ['ATEETBAA002C04', 'ATEETBAA002C05', 'ATEETBAA002C08']);
  });

  it('human:secret을 넣은 판: 금고가 칸을 못 찾으면 금고 창 없이 곧바로 서명 차례(handoff sign) → doneTarget이 보여 [다 했어요] 없이 verify → success', async () => {
    const vault = new FakeVault();
    const o = await realDryRun({ loggedIn: true, secret: { vault, targetId: () => 'T1' }, patchIssue: withSecret });
    assert.equal(o.end?.status, 'success', show(o));
    assert.deepEqual(vault.calls, ['secretWindow.openForHuman'], '금고에 한 번만 묻는다(값은 엔진에 오지 않는다)');
    const at = (t: string) => o.journal.indexOf(t);
    assert.ok(at('human.secret_manual') >= 0 && at('signflow.timeout') > at('human.secret_manual'), show(o));
    assert.ok(at('sign.turn_opened') > at('human.secret_manual') && at('sign.turn_closed') > at('sign.turn_opened'), show(o));
    assert.ok(!o.journal.includes('human.secret_ttl'), '금고 창 TTL을 기다리지 않는다');
    assert.deepEqual(commits(o), ['ATEETBAA002C04', 'ATEETBAA002C05', 'ATEETBAA002C08'], '커밋 요청 각 1번(엔진은 다시 누르지 않는다)');
  });

  it('human:secret을 넣은 판 + 금고 없음(대역): 같은 사람 직접 입력 길로 success', async () => {
    const o = await realDryRun({ loggedIn: true, patchIssue: withSecret });
    assert.equal(o.end?.status, 'success', show(o));
    assert.ok(o.journal.includes('sign.turn_opened'), show(o));
  });
});
