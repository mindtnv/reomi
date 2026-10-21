import browser from 'webextension-polyfill';

async function openCapture(tabId: number, selection: boolean) {
  await browser.storage.local.set({ entry: { tabId, selection, at: Date.now() } });
  try { await browser.action.openPopup(); }
  catch { await browser.windows.create({ url: browser.runtime.getURL('popup.html'), type: 'popup', width: 410, height: 700 }); }
}
browser.runtime.onInstalled.addListener(() => {
  void browser.contextMenus.removeAll().then(() => browser.contextMenus.create({ id: 'reomi-save-selection', title: browser.i18n.getUILanguage().startsWith('ru') ? 'Reomi — сохранить выделенное' : 'Reomi — save selection', contexts: ['selection'], documentUrlPatterns: ['http://*/*', 'https://*/*'] }));
});
browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'reomi-save-selection' && tab?.id != null) void openCapture(tab.id, true);
});
browser.commands.onCommand.addListener(command => {
  if (command === 'capture-selection') void browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab?.id != null ? openCapture(tab.id, true) : undefined);
});

// Chrome can hide local storage from injected/content contexts. Firefox's
// isolated capture script has no token code and receives no credential.
const local = browser.storage.local as typeof browser.storage.local & { setAccessLevel?: (options: { accessLevel: string }) => Promise<void> };
if (local.setAccessLevel) void local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
