// Mac или Windows: от этого зависят подписи клавиш и пара сочетаний.
export const isMac = /Mac/.test(navigator.platform || navigator.userAgent);

// Как называть сочетание «масштаб таймлинии» в подсказках.
export const zoomHint = isMac ? '⌘ + колесо или щипок на трекпаде' : 'Ctrl + колесо';
