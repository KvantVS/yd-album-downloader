// Открываем страницу загрузчика по клику на иконку расширения.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('downloader.html') });
});

// Яндекс проверяет Origin/Referer. Запросы со страницы расширения идут с Origin=chrome-extension://...,
// поэтому подменяем эти заголовки — только для запросов, инициированных самим расширением.
async function installRules() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin',  operation: 'set', value: 'https://disk.yandex.ru' },
          { header: 'Referer', operation: 'set', value: 'https://disk.yandex.ru/client/albums' }
        ]
      },
      condition: {
        initiatorDomains: [chrome.runtime.id],
        requestDomains: ['yandex.ru', 'yandex.net', 'yandex.com'],
        resourceTypes: ['xmlhttprequest']
      }
    }]
  });
}
installRules();
chrome.runtime.onInstalled.addListener(installRules);
chrome.runtime.onStartup.addListener(installRules);
