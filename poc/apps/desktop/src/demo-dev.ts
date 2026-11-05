// 개발 전용 연결(ShellOptions.dev, ADR-035 W-7). 가짜 홈택스(fixture 모드: 가짜 H-01 페이지·시험 정책 금고·임시 앱 폴더),
// 시연 씨앗(견본 거래처·발급 이력·문서함 PDF), 시연 모델 해석 병합을 한 곳에 묶는다.
// 시연 진입점(demo-shell.ts)과 e2e만 import한다. 제품 진입점(shell.ts)은 닿지 않는다(tests/shell-entry.test.ts가 본다).
import { mergeParsed } from './demo-model.ts';
import { startDemoSeed } from './demo-seed.ts';
import { startFixtureMode } from './fixture-mode.ts';
import type { ShellDev } from './shell-app.ts';

export const DEMO_DEV: ShellDev = { startFixture: startFixtureMode, startDemoSeed, mergeParsed };
