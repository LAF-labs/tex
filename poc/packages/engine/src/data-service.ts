import { ConsentRepo, CounterpartyRepo, OnboardingRepo, ProfileRepo, ValidationError, type ConsentInput, type ConsentKind, type Db, type OnboardingState } from '@sax/db';
import { appPaths, defaultAppRoot } from '@sax/platform';
import { parseBizCert } from './bizcert.ts';
import { BizVerifier, BizVerifyError } from './bizverify.ts';
import { DocumentService } from './documents.ts';
import { COMMANDS, READ_QUERIES } from './protocol.ts';

export { COMMANDS, READ_QUERIES };

type Params = Record<string, unknown>;

export type DataMethod = (typeof READ_QUERIES)[number] | (typeof COMMANDS)[number];

export class DataError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const id = (v: unknown): string => {
  if (typeof v !== 'string' || !v) throw new DataError('profile_not_found');
  return v;
};
const nullableId = (v: unknown): string | null => (v === null || v === undefined ? null : id(v));
/** 없으면 사업자(기본). 그 밖의 값은 거부(저장소 load·clear는 종류를 검사하지 않는다). */
const profileKind = (v: unknown): OnboardingState['profileKind'] => {
  if (v === undefined) return 'business';
  if (v === 'business' || v === 'personal') return v;
  throw new DataError('bad_profile_kind');
};

const str = (v: unknown, code: string): string => {
  if (typeof v !== 'string') throw new DataError(code);
  return v;
};
const optStr = (v: unknown, code: string): string | undefined => (v === undefined ? undefined : str(v, code));
/** 렌더러가 아닌 main만 부르지만, 저장소 정규식이 undefined를 'undefined'로 받지 않게 문자열 필드를 먼저 확인한다. */
function consentInput(p: Params): ConsentInput {
  return {
    profileId: nullableId(p.profileId),
    kind: str(p.kind, 'bad_consent_kind') as ConsentKind,
    noticeKey: optStr(p.noticeKey, 'bad_notice_key'),
    noticeVersion: str(p.noticeVersion, 'bad_notice_version'),
    processorsVersion: optStr(p.processorsVersion, 'bad_processors_version'),
    choice: str(p.choice, 'bad_choice') as ConsentInput['choice'],
    at: str(p.at, 'bad_at'),
    via: str(p.via, 'bad_via') as ConsentInput['via'],
    deviceSig: optStr(p.deviceSig, 'bad_device_sig'),
  };
}

/** DB 소유는 엔진 하나다(D07 §1.3, A-24). 이 클래스만 Db 핸들을 갖는다. */
export class DataService {
  readonly profiles: ProfileRepo;
  readonly counterparties: CounterpartyRepo;
  readonly documents: DocumentService;
  readonly consents: ConsentRepo;
  readonly onboarding: OnboardingRepo;
  private readonly verifier: BizVerifier;

  /** vaultDir: 보관함 폴더(기본은 앱 루트의 vault, 처음 쓸 때 정한다). now: 만료 계산 기준 시각(시험용). */
  constructor(db: Db, verifier: BizVerifier, opts: { vaultDir?: string; now?: () => Date } = {}) {
    this.profiles = new ProfileRepo(db);
    this.counterparties = new CounterpartyRepo(db);
    this.documents = new DocumentService(db, () => opts.vaultDir ?? appPaths(defaultAppRoot()).vault, opts.now);
    this.consents = new ConsentRepo(db);
    this.onboarding = new OnboardingRepo(db);
    this.verifier = verifier;
  }

  async handle(method: string, p: Params): Promise<unknown> {
    try {
      return await this.dispatch(method as DataMethod, p);
    } catch (e) {
      if (e instanceof ValidationError || e instanceof BizVerifyError) throw new DataError(e.code);
      throw e;
    }
  }

  private async dispatch(method: DataMethod, p: Params): Promise<unknown> {
    switch (method) {
      case 'db.query.profiles.list':
        return this.profiles.list();
      case 'db.query.counterparties.list':
        return this.counterparties.list(typeof p.q === 'string' ? p.q : undefined);
      case 'db.query.counterparties.get':
        return this.counterparties.get(String(p.id));
      case 'db.query.documents.list':
        return this.documents.list();
      case 'profile.upsert':
        return this.profiles.upsert(p as never);
      case 'profile.delete':
        return this.profiles.delete(String(p.id));
      case 'counterparty.create':
        return this.counterparties.create(p as never);
      case 'counterparty.update':
        return this.counterparties.update(String(p.id), (p.patch ?? {}) as never);
      case 'counterparty.delete':
        return this.counterparties.delete(String(p.id));
      case 'counterparty.status': {
        const cp = this.counterparties.get(String(p.id));
        if (!cp) throw new DataError('not_found');
        const [s] = await this.verifier.status([cp.bizNo]);
        return this.counterparties.setVerification(cp.id, `status:${s?.statusCode || 'unregistered'}`);
      }
      case 'counterparty.verify': {
        const cp = this.counterparties.get(String(p.id));
        if (!cp) throw new DataError('not_found');
        if (!cp.repName) throw new DataError('rep_name_required');
        const r = await this.verifier.validate({ bizNo: cp.bizNo, startDate: String(p.startDate ?? ''), repName: cp.repName, name: cp.name });
        const status = r.valid ? `valid:${r.status?.statusCode || '?'}` : 'invalid';
        return { counterparty: this.counterparties.setVerification(cp.id, status), result: r };
      }
      case 'bizcert.parse':
        return parseBizCert(String(p.text ?? ''));
      case 'bizverify.setKey':
        this.verifier.setServiceKey(typeof p.key === 'string' ? p.key : null);
        return { hasKey: this.verifier.hasKey };
      case 'bizverify.hasKey':
        return { hasKey: this.verifier.hasKey };
      case 'document.import':
        return this.documents.import(p.bytes, p.extract, { altText: p.altText, final: p.final === true });
      case 'document.update':
        return this.documents.update(String(p.id), (p.patch ?? {}) as never, p.seen);
      case 'document.file':
        return { path: await this.documents.filePath(String(p.id)) };
      case 'consent.record':
        return this.consents.record(consentInput(p));
      case 'consent.latest':
        return this.consents.latest(nullableId(p.profileId), str(p.kind, 'bad_consent_kind') as ConsentKind);
      case 'consent.attach':
        return this.consents.attachToProfile(id(p.profileId));
      case 'onboarding.load':
        return this.onboarding.load(profileKind(p.profileKind));
      case 'onboarding.save':
        return this.onboarding.save({ profileKind: profileKind(p.profileKind), profileId: nullableId(p.profileId), step: str(p.step, 'bad_step'), state: p.state });
      case 'onboarding.clear':
        return this.onboarding.clear(profileKind(p.profileKind));
      case 'profile.setPortalLoginId':
        if (p.loginId !== null && typeof p.loginId !== 'string') throw new DataError('bad_login_id');
        return this.profiles.setPortalLoginId(id(p.id), p.loginId);
    }
    throw new DataError('unknown_method');
  }
}
