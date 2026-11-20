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
