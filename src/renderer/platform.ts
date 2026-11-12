// Mac или Windows: от этого зависят подписи клавиш и пара сочетаний.
export const isMac = /Mac/.test(navigator.platform || navigator.userAgent);

// Как называть сочетание «масштаб таймлинии» в подсказках.
// Управление колесом — как в DaVinci Resolve: колесо — дорожки вверх-вниз, Ctrl (⌘) — по времени, Alt (⌥) — масштаб.
export const zoomHint = isMac ? '⌥ + колесо или щипок на трекпаде' : 'Alt + колесо';
export const panHint = isMac ? '⌘ + колесо' : 'Ctrl + колесо';
