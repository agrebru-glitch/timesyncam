import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useApp } from '../App.tsx';
import { api } from '../api.ts';
import { IconMovieMode, IconPhotoMode, IconQr, IconSetupMode, IconTelegram, IconTrash } from '../icons.tsx';
import { panHint, zoomHint } from '../platform.ts';

// Оглавление слева: группы и разделы страницы. id раздела — «faq-<id>»; на часть из них ведут кнопки
// из «Замечаний» (qr-screen, tc-run, tc-preset, audio, manual-sync, raw) — менять их нельзя.
const NAV: { group: string; items: { id: string; label: string }[] }[] = [
  { group: 'Главное', items: [{ id: 'qr-screen', label: 'Экран синхронизации' }] },
  {
    group: 'Как это работает',
    items: [
      { id: 'basics', label: 'Откуда берётся время' },
      { id: 'audio-sync', label: 'Сверка по звуку' },
      { id: 'timeline', label: 'Что видно на таймлинии' },
    ],
  },
  {
    group: 'Sony',
    items: [
      { id: 'tcub', label: 'Меню TC/UB коротко' },
      { id: 'clock', label: '1. Часы' },
      { id: 'tc-run', label: '2. Free Run' },
      { id: 'tc-preset', label: '3. Preset' },
      { id: 'ub', label: '4. User Bit' },
      { id: 'audio', label: '5. Звук' },
      { id: 'manual-sync', label: '6. Хлопок' },
      { id: 'external-tc', label: '7. Внешний тайм-код' },
      { id: 'proxy', label: '8. Прокси' },
      { id: 'copy', label: '9. Копирование карты' },
    ],
  },
  {
    group: 'Другие устройства',
    items: [
      { id: 'other', label: 'Другие камеры' },
      { id: 'recorders', label: 'Рекордеры звука' },
      { id: 'raw', label: 'BRAW, R3D, RAW' },
    ],
  },
  {
    group: 'Монтаж',
    items: [
      { id: 'import', label: 'Как открыть результат' },
      { id: 'about', label: 'О программе' },
    ],
  },
];

// Путь по меню камеры — как в справке Sony: MENU → (значок) Раздел → [Пункт] → значение.
type Crumb = string | { icon: 'movie' | 'setup'; label: string };
function MenuPath({ path, value }: { path: Crumb[]; value?: string }) {
  return (
    <span className="menu-path">
      {path.map((c, i) => (
        <span key={i} className="menu-step">
          {i > 0 && <span className="menu-arrow">→</span>}
          {typeof c === 'string' ? (
            <span className={c === 'MENU' ? 'menu-key' : 'menu-item'}>{c}</span>
          ) : (
            <span className="menu-item with-icon">
              {c.icon === 'movie' ? <IconMovieMode className="menu-icon movie" /> : <IconSetupMode className="menu-icon" />}
              {c.label}
            </span>
          )}
        </span>
      ))}
      {value && (
        <span className="menu-step">
          <span className="menu-arrow">→</span>
          <span className="menu-value">{value}</span>
        </span>
      )}
    </span>
  );
}

const SHOOT: Crumb = { icon: 'movie', label: 'Съёмка' };
const SETUP: Crumb = { icon: 'setup', label: 'Настройка' };

// В каких режимах камеры работает пункт — значки как в начале страниц справки Sony.
function Modes() {
  return (
    <span className="modes" title="Пункты TC/UB работают в видеосъёмке и S&Q, в фото — нет">
      <span className="mode off"><IconPhotoMode className="mode-icon" /></span>
      <span className="mode movie"><IconMovieMode className="mode-icon" /></span>
      <span className="mode sq">S&amp;Q</span>
    </span>
  );
}

function Step({ id, n, title, children }: { id: string; n: number; title: string; children: ReactNode }) {
  return (
    <section id={`faq-${id}`} className="faq-card step-card">
      <div className="step-head">
        <span className="step-badge">{n}</span>
        <h3>{title}</h3>
      </div>
      <div className="step-body">{children}</div>
    </section>
  );
}

export function FaqPage() {
  const { state, dispatch } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState('qr-screen');

  const go = (id: string) => ref.current?.querySelector<HTMLElement>(`#faq-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  useEffect(() => {
    if (!state.faqAnchor || !ref.current) return;
    const el = ref.current.querySelector<HTMLElement>(`#faq-${state.faqAnchor}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('flash');
    const t = setTimeout(() => el.classList.remove('flash'), 1800);
    return () => clearTimeout(t);
  }, [state.faqAnchor]);

  // Подсветка в оглавлении — раздел, верх которого последним прошёл верх страницы.
  useEffect(() => {
    const page = ref.current;
    if (!page) return;
    const ids = NAV.flatMap((g) => g.items.map((i) => i.id));
    const onScroll = () => {
      const top = page.getBoundingClientRect().top + 80;
      let cur = ids[0];
      for (const id of ids) {
        const el = page.querySelector<HTMLElement>(`#faq-${id}`);
        if (el && el.getBoundingClientRect().top <= top) cur = id;
      }
      // Внизу страницы последние короткие разделы до верха не доходят — отмечаем последний.
      if (page.scrollTop + page.clientHeight >= page.scrollHeight - 4) cur = ids[ids.length - 1];
      setActive(cur);
    };
    onScroll();
    page.addEventListener('scroll', onScroll, { passive: true });
    return () => page.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="page faq-page" ref={ref}>
      <div className="faq-shell">
        <nav className="faq-nav" aria-label="Разделы">
          {NAV.map((g) => (
            <div key={g.group} className="faq-nav-group">
              <div className="faq-nav-title">{g.group}</div>
              {g.items.map((i) => (
                <button key={i.id} className={`faq-nav-item ${active === i.id ? 'on' : ''}`} onClick={() => go(i.id)}>{i.label}</button>
              ))}
            </div>
          ))}
        </nav>

        <div className="faq">
          <header className="faq-hero">
            <h1>Настройка камер</h1>
            <p className="lead">Пять минут перед съёмкой экономят часы на монтаже. Сначала — экран синхронизации и как программа ставит клипы, потом — пошаговая настройка Sony и других камер.</p>
          </header>

          <section id="faq-qr-screen" className="faq-card featured">
            <div className="featured-title">
              <span className="featured-icon"><IconQr /></span>
              <div>
                <h2>Экран синхронизации <span className="sync-recommended">рекомендуется</span></h2>
                <p className="muted-line">Контрольный кадр: точнее всего для камер без тайм-кода</p>
              </div>
            </div>
            <div className="featured-body">
              <div>
                <p>Программа показывает QR-код с точным временем, код меняется каждую секунду. Каждая камера снимает этот экран и по нему встаёт на таймлинию с точностью до кадра-двух, даже без общего звука и на большом расстоянии.</p>
                <ol className="flow">
                  <li><b>Откройте экран</b> на ноутбуке или планшете: кнопка справа или «Экран синхронизации» в верхней панели. Лучше во весь экран, яркость побольше.</li>
                  <li><b>Снимите его каждой камерой 5–10 секунд</b>, весь код в кадре и в фокусе. До съёмки, после или в перерыве: время зашито в коде, снимать одновременно не нужно.</li>
                  <li><b>Не выключайте камеру без тайм-кода</b> между съёмкой экрана и события: поправка переносится на все её клипы.</li>
                  <li><b>Отметьте кадр.</b> Правая кнопка по клипу с экраном → «Выбрать контрольным кадром», так для каждой камеры. До синхронизации клипы лежат по порядку съёмки — ищите клип с экраном в начале или в конце дорожки. Отмеченный клип окрасится в цвет камеры, на нём появится флажок.</li>
                  <li><b>«Синхронизировать» → «Контрольный кадр + тайм-код + звук».</b> Камеры с экраном встают по нему, остальные клипы — следом по тайм-коду. Камеры без экрана подтягиваются по звуку. Где у камер с экраном есть общий звук, их взаимное место уточняет звук: экран ошибается на кадр-два из-за задержки экрана, звук — на доли миллисекунды.</li>
                </ol>
              </div>
              <aside className="featured-aside">
                <div className="qr-art"><IconQr /></div>
                <button className="btn primary featured-btn" onClick={() => dispatch({ type: 'qr-screen', open: true })}>Открыть экран синхронизации</button>
                <p className="note-line">Не прочитался экран — программа скажет об этом во вкладке «Замечания». Частые причины: блики, смаз, слишком мелкий код в кадре.</p>
              </aside>
            </div>
          </section>

          <h2 className="faq-group">Как это работает</h2>

          <section id="faq-basics" className="faq-card">
            <h2>Откуда программа берёт время клипа</h2>
            <div className="source-grid">
              <div className="source"><div className="source-name">Часы камеры</div><p>Дата и время начала записи. Есть почти у всех камер, точность — около секунды.</p></div>
              <div className="source"><div className="source-name">Тайм-код</div><p>Счётчик кадров в файле. В режиме Free Run паузы между клипами точны до кадра, даже если сам тайм-код не совпадает с часами. Камера с тайм-кодом от генератора или других камер становится <b>опорной</b>: остальные выравниваются по ней.</p></div>
              <div className="source"><div className="source-name">Звук</div><p>В режиме «Тайм-код + звук» программа сверяет камеры по общему звуку и поправляет то, что не смогли тайм-код и часы.</p></div>
              <div className="source best"><div className="source-name">Экран синхронизации</div><p>Самый точный: QR-код с точным временем, который камеры снимают до или после съёмки.</p></div>
            </div>
          </section>

          <section id="faq-audio-sync" className="faq-card">
            <h2>Сверка по звуку</h2>
            <p>«Синхронизировать» предлагает три режима: <b>«Тайм-код + звук»</b> (по умолчанию), <b>«Только тайм-код»</b> и <b>«Контрольный кадр + тайм-код + звук»</b> — для камер, снимавших экран синхронизации. Сначала клипы встают по тайм-коду и часам, затем программа сверяет их со звуком других камер.</p>
            <div className="fact-grid">
              <div className="fact"><b>Точки зацепки.</b> Где клипы двух камер идут одновременно, программа сравнивает звук и находит сдвиг. Первая точка задаёт поправку для своего клипа и всех следующих. Следующая проверяет: расходится больше чем на пару кадров — поправка меняется с её клипа, предыдущие остаются как были.</div>
              <div className="fact"><b>Камеры без тайм-кода</b> (GoPro, телефоны) ошибаются у каждого клипа по-своему, поэтому каждый клип с общим звуком получает свою поправку.</div>
              <div className="fact"><b>Сбитые часы.</b> Нет общего звука рядом по времени — программа ищет звук камеры по всей записи других камер. Так находятся камеры с неверным часовым поясом или часами, ушедшими на минуты.</div>
              <div className="fact"><b>Точный тайм-код</b> звук не сдвигает, только сверяет. Расхождение обычно значит, что камеры стояли далеко: звук идёт около 340 м/с.</div>
              <div className="fact"><b>Рекордер.</b> Длинная запись сверяется примерно раз в 10 минут; не совпало в одном месте — программа пробует следующее. Часы рекордера за час штатно расходятся с камерами на десятые доли секунды — это допуск, а не ошибка, и запись встаёт по своей середине.</div>
              <div className="fact"><b>Как сравнивается звук.</b> Сначала — «атаки»: хлопки, удары, начала слов в нескольких полосах частот, поэтому встроенный микрофон и рекордер находят друг друга при разной громкости. Потом точка уточняется по самой волне, до долей миллисекунды. Из стерео программа берёт более чистый канал.</div>
            </div>
          </section>

          <section id="faq-timeline" className="faq-card">
            <h2>Что видно на таймлинии</h2>
            <div className="legend">
              <div className="legend-row"><span className="swatch unsure" /><div><b>Без сверки</b> — жёлтый пунктир, у дорожки их число. Звук не подтвердил место клипа (нет общего звука или место по звуку не найдено) или подтвердил хуже кадра. Обычно такие клипы стоят верно, по тайм-коду и часам, но программа это не проверила. Щелчок по числу ведёт к следующему, причина — в меню клипа.</div></div>
              <div className="legend-row"><span className="swatch alone" /><div><b>Не с чем сверить</b> — тонкая серая точка: в это время другие устройства не писали. Это не недочёт сверки: клипы стоят по часам и соседним клипам своей камеры, чьё место звук подтвердил в другое время.</div></div>
              <div className="legend-row"><span className="diamonds"><i className="d set" /><i className="d ok" /><i className="d off" /></span><div><b>Ромбы — точки сверки:</b> зелёный задал или сменил поправку, белый подтвердил, серый отброшен — противоречил соседним. Выключить поправку для камеры можно галочкой «Поправлять по звуку» в её карточке.</div></div>
              <div className="legend-row"><span className="swatch order" /><div><b>Порядок дорожек</b> — по количеству материала: сверху камеры, у которых его меньше, ниже — где больше; дорожки только со звуком — под камерами. В экспорте порядок тот же: камера с наибольшим количеством материала — ниже всех видеодорожек, вставки — над ней.</div></div>
            </div>
            <p><b>Волна звука</b> нарисована внутри клипов. Приблизьте таймлинию ({zoomHint}) — хлопки разных камер встанут на одну вертикаль, стыковку видно глазами. Кнопка «Волна» над дорожками прячет и показывает её. Управление колесом — как в DaVinci: колесо — дорожки вверх-вниз, {panHint} — по времени, {zoomHint} — масштаб.</p>
            <p><b>Звук в предпросмотре.</b> Звучат все дорожки, каждая на своём месте с точностью до сэмпла: совпавшие записи звучат как одна, разошедшиеся — эхом. Громкость дорожек выравнивается, тихий рекордер не тонет в звуке камер. <b>M</b> и <b>S</b> у названия дорожки выключают её звук или оставляют только её; кнопка «Звук» над предпросмотром выключает звук совсем.</p>
          </section>

          <h2 className="faq-group">Sony: A7 IV, A7S III, A7C II, A1, FX3, FX30 и другие</h2>

          <section id="faq-tcub" className="faq-card tcub">
            <div className="tcub-head">
              <div>
                <h2>Меню TC/UB коротко</h2>
                <MenuPath path={['MENU', SHOOT, 'TC/UB']} />
              </div>
              <Modes />
            </div>
            <table className="tc-table">
              <thead><tr><th>Пункт</th><th>Что поставить</th><th>Зачем</th></tr></thead>
              <tbody>
                <tr><td className="mono">Time Code Run</td><td><span className="tc-val">Free Run</span></td><td>Тайм-код идёт всё время, и паузы между клипами точны до кадра. В Rec Run он стоит, пока камера не пишет.</td></tr>
                <tr><td className="mono">Time Code Make</td><td><span className="tc-val">Preset</span></td><td>Regenerate продолжает тайм-код с последнего клипа на карте и всегда работает как Rec Run.</td></tr>
                <tr><td className="mono">Time Code Preset</td><td><span className="tc-val">≈ время суток</span></td><td>Удобно читать на монтаже; до кадра совпадать не обязано. Сброс на 00:00:00:00 — кнопка <IconTrash className="inline-icon" /> (Удалить).</td></tr>
                <tr><td className="mono">User Bit Time Rec</td><td><span className="tc-val">Вкл.</span></td><td>Камера дополнительно пишет время по часам — запасной источник.</td></tr>
                <tr><td className="mono">Time Code Format</td><td><span className="tc-val soft">DF или NDF</span></td><td>Только при NTSC (29,97). Программа понимает оба. С DF тайм-код идёт вровень с часами, с NDF отстаёт на 3,6 с за час. При 24p пункт недоступен.</td></tr>
                <tr><td className="mono">User Bit Preset</td><td><span className="tc-val soft">не трогать</span></td><td>Программе не нужен.</td></tr>
              </tbody>
            </table>
            <p className="note-line">По справке Sony для A7 IV; на других моделях пункты называются так же. На старых моделях раздел — <MenuPath path={['MENU', SETUP, 'Настройки TC/UB']} />.</p>
          </section>

          <div className="step-grid">
            <Step id="clock" n={1} title="Выставьте часы на всех камерах">
              <p>Одинаковые дата, время и часовой пояс — с точностью до секунды. Удобно по одному телефону: подготовьте время на минуту вперёд и подтвердите ровно в начале минуты.</p>
              <MenuPath path={['MENU', SETUP, 'Регион/дата/время']} />
              <p>Во время съёмки часы не трогайте. Камера «забыла» дату после смены аккумулятора — села внутренняя батарейка часов: поставьте камеру на зарядку.</p>
            </Step>

            <Step id="tc-run" n={2} title="Тайм-код: Free Run">
              <MenuPath path={['MENU', SHOOT, 'TC/UB', 'Time Code Run']} value="Free Run" />
              <p>В <b>Rec Run</b> тайм-код идёт, только пока камера пишет, и паузы между клипами пропадают. Программе придётся брать время с часов — точность упадёт до секунды. По справке Sony, даже в Rec Run тайм-код может прерваться при смене формата записи или извлечении карты.</p>
            </Step>

            <Step id="tc-preset" n={3} title="Тайм-код: Preset и текущее время">
              <MenuPath path={['TC/UB', 'Time Code Make']} value="Preset" />
              <p>В Regenerate тайм-код продолжается с последнего клипа на карте и ведёт себя как Rec Run. При двойной записи он читается с карты в слоте 1.</p>
              <MenuPath path={['TC/UB', 'Time Code Preset']} value="≈ время суток" />
              <p>Колесом выставьте пары цифр, нажмите центр. Программа сама вычислит, на сколько тайм-код расходится с часами, а время суток удобно читать на монтаже. После обновления прошивки тайм-код сбрасывается — выставьте его снова.</p>
            </Step>

            <Step id="ub" n={4} title="User Bit Time Rec — включить">
              <MenuPath path={['TC/UB', 'User Bit Time Rec']} value="Вкл." />
              <p>Камера дополнительно запишет время по часам — запасной источник, если что-то пойдёт не так.</p>
            </Step>

            <Step id="audio" n={5} title="Звук на каждой камере">
              <p>Даже если основной звук пишется отдельно, держите встроенный микрофон включённым: по нему программа сверяет камеры между собой.</p>
              <MenuPath path={['Запись звука']} value="Вкл." />
              <p>Уровень записи — не на нуле. Звук выключен — в файле тишина, и программа скажет: «в звуке тишина — сверить по звуку нельзя».</p>
            </Step>

            <Step id="manual-sync" n={6} title="Хлопок в начале и после перерывов">
              <p>Хлопок или вспышка, которые видят все камеры, — отличная точка для сверки по звуку. Камеру без общего звука подгоните по кадру хлопка в монтажке; сдвиг на целые часы или сутки (неверный пояс, сбитая дата) программа предложит сама во вкладке «Замечания».</p>
              <p>На стадионе звук идёт около 340 м/с: камеры в 70 м друг от друга услышат его с разницей примерно в 5 кадров. Подгоняйте по картинке — удар по мячу, вспышка, хлопок в кадре.</p>
            </Step>

            <Step id="external-tc" n={7} title="Внешний тайм-код — опорная камера">
              <p>FX3 (прошивка 2.00 и новее) и FX30 принимают тайм-код по кабелю <b>VMC-BNCM1</b> от генератора (Tentacle Sync, Deity, RØDE Wireless PRO). Тайм-код такой камеры — точное время, она становится опорной.</p>
              <p>Не распознала сама — в карточке камеры выберите «Тайм-код: точный — синхронизирован». Для A7 IV в справке Sony вход тайм-кода не упоминается — для неё часы, Free Run и хлопок.</p>
            </Step>

            <Step id="proxy" n={8} title="Прокси — для быстрого предпросмотра">
              <MenuPath path={['MENU', SHOOT, 'Качество изображения', 'Настройки прокси', 'Прокси-запись']} value="Вкл." />
              <p>Формат <b>XAVC S HD</b> (H.264, 8 бит). Оригиналы 4:2:2 10 бит встроенный плеер не проигрывает и показывает стоп-кадрами. При 100p и 120p камера прокси не пишет.</p>
            </Step>

            <Step id="copy" n={9} title="Копируйте карту целиком">
              <p>Вместе с файлами <span className="path">C0001M01.XML</span> рядом с клипами: в них Sony пишет время съёмки и тайм-код. Не переименовывайте и не пересохраняйте клипы — сломается связь с XML и прокси. Потерялся XML — программа прочитает такой же внутри клипа.</p>
              <p>Каждая камера и каждый рекордер — в свою папку: перетащите папку съёмки целиком, и каждая папка станет своей дорожкой. Карты одной камеры программа соберёт на одну дорожку по серийному номеру из XML; если номера нет — перетащите вторую карту прямо на дорожку камеры.</p>
            </Step>
          </div>

          <h2 className="faq-group">Другие устройства</h2>

          <div className="card-grid">
            <section id="faq-other" className="faq-card">
              <h3>Canon, Panasonic, Fujifilm, Nikon, Blackmagic</h3>
              <p>В меню тайм-кода — <b>Free Run</b> (свободный счёт) и тайм-код по текущему времени, если камера умеет. Часы — по одному источнику, как у Sony. Камеры с входом тайм-кода подключайте к генератору — они станут опорными.</p>
              <h3>GoPro, DJI, экшн-камеры</h3>
              <p>Время выставляется с телефона при подключении к приложению (GoPro Quik, DJI Fly / Mimo) — подключите каждую камеру перед съёмкой. GoPro и часть DJI пишут местное время с пометкой UTC, программа это учитывает. Уехала камера на целые часы — во вкладке «Замечания» будет кнопка сдвига.</p>
              <h3>iPhone и Android</h3>
              <p>Часы телефонов сверяются с сетью и обычно точны. Приложения вроде Blackmagic Camera дополнительно пишут тайм-код.</p>
            </section>

            <div className="card-stack">
              <section id="faq-recorders" className="faq-card">
                <h3>Рекордеры звука</h3>
                <p>Zoom, Tascam, Sound Devices и другие пишут WAV с меткой времени (BWF). Перетащите папку рекордера на отдельную дорожку — он встанет по своему тайм-коду или часам. Часы рекордера выставьте те же, что у камер.</p>
                <p>В мультивью у рекордера вместо видео — «Только звук» и волна вокруг курсора: хлопок должен дойти до красной линии одновременно с хлопком в кадре у камер.</p>
              </section>
              <section id="faq-raw" className="faq-card">
                <h3>BRAW, R3D, Canon RAW, ARRIRAW</h3>
                <p>Эти форматы читают только фирменные программы. Перегоните их в ProRes или H.264/H.265 с сохранением тайм-кода (например, в DaVinci Resolve) и добавьте полученные файлы.</p>
              </section>
            </div>
          </div>

          <h2 className="faq-group">Монтаж</h2>

          <section id="faq-import" className="faq-card">
            <h2>Как открыть результат</h2>
            <div className="import-grid">
              <div className="import-app">
                <div className="source-name">DaVinci Resolve</div>
                <p>В окне экспорта — <b>«DaVinci Resolve — FCPXML»</b> или <b>«DaVinci Resolve — XML»</b>. В Resolve: <span className="path">File → Import → Timeline…</span> и сохранённый файл.</p>
                <p><b>FCPXML</b> — стерео одной дорожкой, рекордер с точностью до сэмпла, но звук по дорожкам Resolve раскладывает сам. <b>XML</b> — звук каждой камеры на своих дорожках: A1 и A2 — левый и правый канал камеры на V1, дальше вверх по видео, рекордеры — ниже всех.</p>
              </div>
              <div className="import-app">
                <div className="source-name">Premiere Pro</div>
                <p>В окне экспорта — <b>«Premiere Pro — XML»</b>. В Premiere: <span className="path">File → Import…</span> и файл <span className="path">.xml</span> — появится секвенция с камерами на своих дорожках.</p>
              </div>
            </div>
            <p className="note-line">Оригиналы программа не меняет: в файле только ссылки на них и их места на таймлинии.</p>
          </section>

          <section id="faq-about" className="faq-card about">
            <h2>TimesynCam {__APP_VERSION__}</h2>
            <p>Разработчик — Andrey Grebenikov. Лицензия GNU GPL версии 3: программу можно свободно использовать, изучать и дорабатывать, сохраняя открытость кода.</p>
            <p>Видео читает FFmpeg (лицензия LGPL). Исходный код и релизы: <button className="link" onClick={() => void api.openLink('github')}>github.com/agrebru-glitch/timesyncam</button>.</p>
            <p>Программа бесплатная. Если она экономит вам время на монтаже — <button className="link" onClick={() => void api.openLink('support')}>поддержите проект</button>.</p>
            <p>Новости, новые версии и вопросы — в Telegram-канале: <button className="link link-icon" onClick={() => void api.openLink('telegram')}><IconTelegram className="icon" /> t.me/timesyncam</button>.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
