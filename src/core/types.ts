// Общие типы. Время везде хранится в секундах Unix-эпохи (float), как реальное время съёмки.

export interface Rate {
  num: number;
  den: number;
}

export interface ClipTimecode {
  text: string; // как показывает камера: 23:30:29:02
  seconds: number; // секунды от полуночи тайм-кода
  countRate: number; // по сколько кадров считается тайм-код: 25, 30, 50...
  drop: boolean;
  source: 'sony-xml' | 'container' | 'bwf';
}

export interface ClipClock {
  epochSec: number; // начало записи по часам камеры
  precisionSec: number; // насколько можно верить: 1 с для Sony XML, больше для даты файла
  tzOffsetMin: number | null; // часовой пояс камеры, если она его записала
  source: 'sony-xml' | 'container' | 'filename' | 'file';
  note?: string; // пояснение, если время пришлось толковать (GoPro, DJI)
}

export interface CameraInfo {
  make?: string;
  model?: string;
  lens?: string;
  gamma?: string;
  serial?: string;
}

export interface ClipMeta {
  id: string;
  path: string;
  name: string;
  sizeBytes: number;
  durationSec: number; // длина файла — столько клип займёт на таймлинии монтажки
  recordedSec: number; // сколько реально длилась запись (отличается у замедленной и ускоренной съёмки)
  captureFps: number | null; // частота съёмки, если она отличается от частоты файла (S&Q, таймлапс)
  rate: Rate | null;
  frames: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  codecLabel: string | null; // как назовёт монтажёр: H.264 4:2:2 10-bit, ProRes 422 HQ, WAV 24-bit
  hasVideo: boolean;
  audioChannels: number;
  audioSampleRate: number | null;
  tc: ClipTimecode | null;
  clock: ClipClock | null;
  camera: CameraInfo;
  proxyPath: string | null;
  playable: boolean; // можно ли проиграть оригинал во встроенном плеере
}

export type Severity = 'error' | 'warning' | 'info';

export type IssueAction =
  | { kind: 'show-clip'; clipId: string }
  | { kind: 'shift-camera'; cameraId: string; seconds: number }
  | { kind: 'exclude-clips'; cameraId: string; clipIds: string[] }
  | { kind: 'open-faq'; anchor: string };

export interface Issue {
  id: string;
  severity: Severity;
  cameraId: string | null;
  clipId?: string;
  title: string;
  details?: string;
  actions: IssueAction[];
}

// Откуда камера берёт время на таймлинии.
export type TimeSource =
  | 'timecode' // тайм-код = реальное время (Tentacle, jam sync, выставлен по часам) — точно до кадра
  | 'timecode-and-clock' // тайм-код не синхронизирован: паузы по нему, время суток по часам
  | 'clock'; // только часы камеры

// Как пользователь велел относиться к тайм-коду камеры.
export type TimecodeTrust =
  | 'auto' // программа решает сама
  | 'absolute' // тайм-код точный: синхронизирован с генератором или другими камерами
  | 'relative' // тайм-код не синхронизирован: только паузы между клипами
  | 'ignore'; // не использовать тайм-код

export interface Camera {
  id: string;
  name: string;
  folders: string[];
  clips: ClipMeta[];
  manualShiftSec: number;
  timecodeTrust: TimecodeTrust;
  excludedClipIds: string[]; // убраны с таймлинии пользователем (файлы на диске не трогаются)
  audioAssist: boolean; // поправлять камеру по звуку
  scanning: { done: number; total: number } | null;
}

export interface Placement {
  clipId: string;
  cameraId: string;
  start: number;
  end: number;
  method: 'timecode' | 'timecode-and-clock' | 'clock';
  lane: number; // 0 — основная дорожка камеры, 1+ — если клипы накладываются
}

export interface CameraSync {
  cameraId: string;
  timeSource: TimeSource | null;
  timecodeVsClockSec: number | null; // насколько тайм-код камеры отличается от её часов
  timecodeJumps: number;
  recRun: boolean;
  start: number | null;
  end: number | null;
  lanes: number;
}

export interface SyncResult {
  placements: Placement[];
  cameras: CameraSync[];
  issues: Issue[];
  start: number;
  end: number;
  displayTzOffsetMin: number;
}
