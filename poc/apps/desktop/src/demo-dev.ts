import { mergeParsed } from './demo-model.ts';
import { startDemoSeed } from './demo-seed.ts';
import { startFixtureMode } from './fixture-mode.ts';
import { MOCK_CP_CERT, MockOnboardingPorts } from './onboarding-mock.ts';
import type { ShellDev } from './shell-app.ts';
import { g24Candidates, mockBundle, MOCK_SETTINGS, MockStore, PROFILES, QUICK, seedTimeline } from './shell-mock.ts';

export const DEMO_DEV: ShellDev = {
  startFixture: startFixtureMode,
  startDemoSeed,
  mergeParsed,
  sample: {
    store: () => new MockStore(),
    profiles: PROFILES,
    timeline: seedTimeline,
    quick: QUICK,
    bundle: mockBundle,
    settings: MOCK_SETTINGS,
    g24Candidates,
    onboarding: () => new MockOnboardingPorts({ saveProfile: async () => {} }),
    cpCert: MOCK_CP_CERT,
  },
};
