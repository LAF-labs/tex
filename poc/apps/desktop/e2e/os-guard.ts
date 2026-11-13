// e2e가 대표 화면에 실제 OS 창을 띄우지 않게 한다(대표 보고 2026-11-13: 시험 중 Finder 창이 떠서 닫을 때까지 시험이 멈춤).
// 모든 Electron e2e 입구가 이 모듈을 맨 먼저 불러온다(tests/e2e-os-guard.test.ts가 지킨다).
// Finder(openPath·showItemInFolder), 기본 브라우저(openExternal), 파일·메시지 대화상자를 대역으로 바꾸고 부른 것을 osCalls에 남긴다.
// 시험이 값을 보려면 이 대역 위에 자기 대역을 다시 씌운다(shell-docs-e2e·demo-seed-e2e처럼). 실제 창을 띄우는 검사는 SAX_E2E_HEADFUL=1에서만 돈다.
import { dialog, shell } from 'electron';

export const osCalls: Array<{ fn: string; arg: string }> = [];
const note = (fn: string, arg: unknown) => void osCalls.push({ fn, arg: typeof arg === 'string' ? arg : '' });

shell.openPath = (async (p: string) => (note('openPath', p), '')) as typeof shell.openPath;
shell.showItemInFolder = ((p: string) => note('showItemInFolder', p)) as typeof shell.showItemInFolder;
shell.openExternal = (async (u: string) => note('openExternal', u)) as typeof shell.openExternal;
dialog.showOpenDialog = (async () => (note('showOpenDialog', ''), { canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
dialog.showSaveDialog = (async () => (note('showSaveDialog', ''), { canceled: true, filePath: '' })) as typeof dialog.showSaveDialog;
dialog.showMessageBox = (async () => (note('showMessageBox', ''), { response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
dialog.showErrorBox = ((title: string, content: string) => (note('showErrorBox', title), console.log(`[os-guard] 오류 상자 대신: ${title}: ${content}`))) as typeof dialog.showErrorBox;
