import type { ReactElement } from 'react';

type P = { className?: string };
const base = (path: ReactElement, cls = 'icon') => (
  <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);

export const IconPlay = ({ className }: P) => base(<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none" />, className);
export const IconPause = ({ className }: P) => base(<g fill="currentColor" stroke="none"><rect x="7" y="5" width="3.5" height="14" rx="1" /><rect x="13.5" y="5" width="3.5" height="14" rx="1" /></g>, className);
export const IconPrev = ({ className }: P) => base(<g><path d="M18 6l-8 6 8 6z" fill="currentColor" stroke="none" /><path d="M7 6v12" /></g>, className);
export const IconNext = ({ className }: P) => base(<g><path d="M6 6l8 6-8 6z" fill="currentColor" stroke="none" /><path d="M17 6v12" /></g>, className);
export const IconFrameBack = ({ className }: P) => base(<path d="M14.5 6l-6 6 6 6" />, className);
export const IconFrameFwd = ({ className }: P) => base(<path d="M9.5 6l6 6-6 6" />, className);
export const IconSync = ({ className }: P) => base(<g><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" /><path d="M20 20v-4h-4" /></g>, className);
export const IconExport = ({ className }: P) => base(<g><path d="M12 4v11" /><path d="M7.5 10.5L12 15l4.5-4.5" /><path d="M5 19h14" /></g>, className);
export const IconPlus = ({ className }: P) => base(<g><path d="M12 5v14" /><path d="M5 12h14" /></g>, className);
export const IconFolder = ({ className }: P) => base(<path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />, className);
export const IconQr = ({ className }: P) => base(<g><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><path d="M14 14h2v2h-2zM18 14h2M14 18v2M17 17h3v3h-3z" /></g>, className);

export const IconHeart = ({ className }: P) => base(<path d="M12 19.5s-7.5-4.6-7.5-10A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 7.5 2.5c0 5.4-7.5 10-7.5 10z" />, className);

// Знак программы — как иконка приложения: клипы камер и курсор синхронизации.
export const LogoMark = ({ className }: P) => (
  <svg className={className} viewBox="70 96 372 312" aria-hidden="true">
    <rect x="84" y="150" width="120" height="52" rx="14" fill="#3d8bfd" opacity="0.45" />
    <rect x="300" y="150" width="128" height="52" rx="14" fill="#3d8bfd" />
    <rect x="96" y="232" width="84" height="52" rx="14" fill="#b07cff" opacity="0.45" />
    <rect x="300" y="232" width="96" height="52" rx="14" fill="#b07cff" />
    <rect x="84" y="314" width="150" height="52" rx="14" fill="#2fc6b4" opacity="0.45" />
    <rect x="300" y="314" width="128" height="52" rx="14" fill="#2fc6b4" />
    <rect x="290" y="112" width="8" height="290" rx="4" fill="#ff5f57" />
    <path d="M270 100 h48 l-24 30 z" fill="#ff5f57" />
  </svg>
);

export const IconX = ({ className }: P) => base(<g><path d="M6 6l12 12" /><path d="M18 6L6 18" /></g>, className);
export const IconAlert = ({ className }: P) => base(<g><path d="M12 4l9 16H3z" /><path d="M12 10v4" /><path d="M12 17v.5" /></g>, className);
export const IconError = ({ className }: P) => base(<g><circle cx="12" cy="12" r="8.5" /><path d="M12 8v5" /><path d="M12 16v.5" /></g>, className);
export const IconInfo = ({ className }: P) => base(<g><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5" /><path d="M12 8v.5" /></g>, className);
export const IconLock = ({ className }: P) => base(<g><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></g>, className);
export const IconCheck = ({ className }: P) => base(<path d="M5 12.5l4.5 4.5L19 7.5" />, className);
