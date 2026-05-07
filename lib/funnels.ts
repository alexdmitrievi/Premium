// Машина состояний для воронок Telegram/MAX-ботов.
// Один пользователь = одна сессия (см. таблицу bot_sessions).
// Шаги детерминированные: получили событие → определили текущий step
// → собрали ответ + новый step + патч state.

import type { ServiceKind } from './supabase';

// ---------------------------------------------------------------------------
// Верхний уровень — "экран". Сессия в bot_sessions.funnel хранит код экрана
// (например, 'order:lawn_mowing'), а bot_sessions.step — внутренний шаг.
// ---------------------------------------------------------------------------
export type Screen =
  | 'home'
  | 'order'        // активная воронка заказа
  | 'orders'       // экран "Мои заказы" (список)
  | 'order_card'   // карточка одного заказа
  | 'repeat'       // быстрый повтор заказа
  | 'edit_date'    // изменение даты у существующего заказа
  | 'referral'     // экран реферальной программы
  | 'referral_list'
  | 'help'
  | 'operator';

export type FunnelId = 'main' | 'order' | 'repeat' | 'edit_date' | 'referral' | 'operator';

// Расширенный набор шагов для воронки заказа.
// Сохранён старый набор STEPS для обратной совместимости с уже задеплоенным кодом.
export const STEPS = [
  'service', 'area', 'district', 'description', 'photos', 'date', 'phone', 'done',
] as const;
export type Step = (typeof STEPS)[number];

export const ORDER_STEPS = [
  'service', 'params', 'district', 'when', 'photos', 'confirm', 'phone', 'done',
] as const;
export type OrderStep = (typeof ORDER_STEPS)[number];

// ---------------------------------------------------------------------------
// State (расширен; старые поля сохранены)
// ---------------------------------------------------------------------------
export type SessionState = {
  // экран
  screen?: Screen;

  // воронка заказа
  serviceKind?: ServiceKind;
  serviceVariant?: 'scarification' | 'aeration' | 'scarification+aeration';
  poolKind?: 'pool_cleaning' | 'pool_assembly' | 'pool_winter' | 'pool_other';
  landSubtasks?: Array<'overgrowth' | 'tree' | 'stump' | 'debris'>;

  area?: number;
  areaUnit?: string;
  areaBucket?: string;        // '5','10','20','30','custom'
  district?: string;          // человекочитаемое
  districtCode?: string;      // 'chkalovskiy', 'other', ...
  description?: string;
  mediaIds?: string[];

  whenLabel?: string;         // 'today' | 'tomorrow' | 'weekend' | 'thisweek' | 'custom'
  whenCustom?: string;
  whenHuman?: string;         // отрисованное "эти выходные"
  whenFrom?: string;          // YYYY-MM-DD
  whenTo?: string;

  phone?: string;

  // вычисленная скидка к моменту confirm
  discountPercent?: number;
  bonusRub?: number;

  // если сейчас экран order_card / repeat / edit_date — id активного лида
  activeLeadId?: string;

  // реферальный визит — пришёл ли по ссылке
  referredBy?: string;        // referrer_contact_id
};

// ---------------------------------------------------------------------------
// Лейблы и подсказки цен
// ---------------------------------------------------------------------------
export const SERVICE_LABEL: Record<ServiceKind, string> = {
  lawn_mowing: 'Покос газона',
  scarification: 'Скарификация',
  aeration: 'Аэрация',
  land_clearing: 'Расчистка участка',
  tree_cutting: 'Спил деревьев',
  stump_removal: 'Корчевание пней',
  debris_removal: 'Уборка мусора',
  pool_cleaning: 'Чистка бассейна',
  pool_assembly: 'Сборка бассейна',
};

export const PRICE_HINT: Record<ServiceKind, string> = {
  lawn_mowing:    '≈ 250–600 ₽ за сотку (зависит от высоты травы и рельефа)',
  scarification:  '≈ 400–800 ₽ за сотку',
  aeration:       '≈ 350–700 ₽ за сотку',
  land_clearing:  '≈ 600–1500 ₽ за сотку (зависит от состояния)',
  tree_cutting:   '≈ 1500–15000 ₽ за дерево (по диаметру и сложности)',
  stump_removal:  '≈ 1500–8000 ₽ за пень',
  debris_removal: '≈ 1500–4000 ₽ за час работы бригады',
  pool_cleaning:  '≈ 200–400 ₽ за м³',
  pool_assembly:  '≈ 3000–12000 ₽ за бассейн',
};

// Диапазоны для расчёта итоговой "вилки".
// За единицу — площадь или штука; сюда же базовый минимум для покоса.
export const PRICE_RANGE: Record<ServiceKind, { min: number; max: number; minOrder?: number }> = {
  lawn_mowing:    { min: 250, max: 600, minOrder: 1500 },
  scarification:  { min: 400, max: 800 },
  aeration:       { min: 350, max: 700 },
  land_clearing:  { min: 600, max: 1500 },
  tree_cutting:   { min: 1500, max: 15000 },
  stump_removal:  { min: 1500, max: 8000 },
  debris_removal: { min: 1500, max: 4000 },
  pool_cleaning:  { min: 200, max: 400 },
  pool_assembly:  { min: 3000, max: 12000 },
};

// Карта районов Омска (5 ключевых + other). UI показывает name, в state кладём code.
export const DISTRICTS: Array<{ code: string; name: string }> = [
  { code: 'chkalovskiy',  name: 'Чкаловский' },
  { code: 'kirovskiy',    name: 'Кировский' },
  { code: 'leninskiy',    name: 'Ленинский' },
  { code: 'oktyabrskiy',  name: 'Октябрьский' },
  { code: 'sovetskiy',    name: 'Советский' },
  { code: 'other',        name: 'Другой' },
];

export function districtName(code?: string): string | undefined {
  if (!code) return undefined;
  return DISTRICTS.find(d => d.code === code)?.name;
}

// ---------------------------------------------------------------------------
// Маппинг lead.status → пользовательский UI
// ---------------------------------------------------------------------------
export type StatusUi = { icon: string; label: string };
export const STATUS_UI: Record<string, StatusUi> = {
  new:          { icon: '🟡', label: 'Принят, обрабатываем' },
  qualifying:   { icon: '🟡', label: 'Уточняем детали' },
  qualified:    { icon: '🟡', label: 'Уточняем детали' },
  quoted:       { icon: '🟢', label: 'Цена согласована, ждём подтверждения дня' },
  scheduled:    { icon: '🟢', label: 'Согласован, мастер приедет' },
  in_progress:  { icon: '🔵', label: 'Мастер на объекте' },
  done:         { icon: '✅', label: 'Выполнен' },
  lost:         { icon: '⚪️', label: 'Отменён' },
  archived:     { icon: '⚪️', label: 'В архиве' },
};

export function mapStatusToUi(status: string): StatusUi {
  return STATUS_UI[status] ?? STATUS_UI.new!;
}

export function canCancelStatus(status: string): boolean {
  return ['new','qualifying','qualified','quoted','scheduled'].includes(status);
}
export function canEditDateStatus(status: string): boolean {
  return ['new','qualifying','qualified','quoted','scheduled'].includes(status);
}

// ---------------------------------------------------------------------------
// Тексты UI (новый набор UI; старый TEXT сохранён для совместимости)
// ---------------------------------------------------------------------------
export const TEXT = {
  welcome: (name?: string) =>
    `Здравствуйте${name ? ', ' + name : ''}! 👋\n` +
    `Я бот <b>«Премиум — уход за участком»</b> в Омске.\n\n` +
    `Помогаю быстро рассчитать и заказать:\n` +
    `• 🌱 покос газона;\n` +
    `• 🌿 скарификацию и аэрацию;\n` +
    `• 🪓 расчистку участка, спил, вывоз мусора;\n` +
    `• 🏊 чистку и сборку бассейнов.\n\n` +
    `Выберите услугу — я задам пару уточняющих вопросов и передам заявку мастеру.`,

  serviceSelected: (k: ServiceKind) =>
    `Отлично, оформляем «<b>${SERVICE_LABEL[k]}</b>».\n` +
    `Ориентир по цене: ${PRICE_HINT[k]}.\n\n` +
    `Подскажите, пожалуйста, ${areaQuestion(k)}`,

  askDistrict:    'В каком районе/посёлке участок?',
  askDescription: 'Коротко опишите задачу: что нужно сделать, есть ли сложности (склон, кусты, мусор и т.п.).',
  askPhotos:      'Если есть, отправьте 1–3 фото объекта. Если фото не нужны — нажмите «Пропустить».',
  askDate:        'Когда удобно приехать?',
  askPhone:       'И последний шаг — телефон, чтобы мастер связался для подтверждения.',
  thanks: (k: ServiceKind) =>
    `Спасибо! Заявка на «${SERVICE_LABEL[k]}» принята ✅\n` +
    `Мастер свяжется с вами в ближайший рабочий час, обычно в течение 30 минут.`,

  operator:
    `Передаю вас оператору 👨‍🔧\n` +
    `Напишите, что вас интересует — и оставьте номер. Мы перезвоним в течение 30 минут (рабочее время 9:00–21:00).`,

  unknown:
    `Не уловил вопрос 🙈 Воспользуйтесь меню ниже или напишите оператору.`,

  unsubscribed:
    `Вы отписаны от рассылок. Если захотите снова получать сезонные напоминания — напишите «вернуться».`,
};

function areaQuestion(k: ServiceKind): string {
  switch (k) {
    case 'lawn_mowing':
    case 'scarification':
    case 'aeration':
    case 'land_clearing':
      return 'какая площадь участка (в сотках или м²)?';
    case 'tree_cutting':
      return 'сколько деревьев нужно спилить и какого они диаметра?';
    case 'stump_removal':
      return 'сколько пней и какого диаметра?';
    case 'debris_removal':
      return 'примерный объём мусора (мешки/кубы) и тип (бытовой/строительный/растительный)?';
    case 'pool_cleaning':
      return 'размер бассейна (диаметр/длина × ширина × глубина)?';
    case 'pool_assembly':
      return 'размер и тип бассейна (каркасный/наземный, диаметр)?';
  }
}

// ---------------------------------------------------------------------------
// UI — новые тексты (Telegram + MAX варианты)
// Для MAX используется флаг strict=true — без декоративных эмодзи.
// ---------------------------------------------------------------------------
export const UI = {
  homeWelcome: (name?: string, strict = false) =>
    strict
      ? `Здравствуйте${name ? ', ' + name : ''}.\n` +
        `Бот «Премиум — уход за участком», Омск. Выберите услугу или раздел.`
      : `👋 Здравствуйте${name ? ', ' + name : ''}!\n` +
        `Я — бот «Премиум — уход за участком». Помогу заказать работы по дому и участку в Омске за пару минут.`,
  homeMenu: 'Что вас интересует?',

  // Воронка заказа
  orderServiceIntro: (k: ServiceKind) =>
    `<b>${SERVICE_LABEL[k]}</b>\n` +
    `Стандартная цена: ${PRICE_HINT[k]}.`,

  askArea: (k: ServiceKind) => {
    if (k === 'lawn_mowing' || k === 'scarification' || k === 'aeration' || k === 'land_clearing')
      return 'Какая площадь участка?';
    if (k === 'pool_cleaning' || k === 'pool_assembly') return 'Какой размер бассейна?';
    if (k === 'tree_cutting') return 'Сколько деревьев нужно спилить?';
    if (k === 'stump_removal') return 'Сколько пней?';
    return 'Опишите параметры объекта.';
  },

  askDistrictTitle: 'В каком районе участок?',
  askWhenTitle:     'Когда удобно?',
  askPhotosTitle:   'Можно прислать 1–3 фото объекта (или пропустить).',
  askPhoneTitle:    'Последний шаг — телефон, чтобы мастер позвонил подтвердить время.',

  orderConfirm: (p: {
    service: string; area?: string; district?: string; when?: string;
    priceLow: number; priceHigh: number;
    discountPercent?: number; bonusRub?: number;
    finalLow?: number; finalHigh?: number;
  }) => {
    const lines: string[] = [];
    lines.push('✅ <b>Проверьте, всё верно?</b>\n');
    lines.push(`Услуга: <b>${p.service}</b>`);
    if (p.area)     lines.push(`Объём: ${p.area}`);
    if (p.district) lines.push(`Район: ${p.district}`);
    if (p.when)     lines.push(`Когда: ${p.when}`);
    lines.push('');
    lines.push(`Цена: ${formatRub(p.priceLow)}–${formatRub(p.priceHigh)} ₽ (точно скажет мастер на месте)`);
    if (p.discountPercent || p.bonusRub) {
      const parts: string[] = [];
      if (p.discountPercent) parts.push(`−${p.discountPercent} % (постоянный клиент)`);
      if (p.bonusRub)        parts.push(`−${p.bonusRub} ₽ (реферальный бонус)`);
      lines.push(`🎁 Ваша скидка: ${parts.join(' и ')}`);
      if (p.finalLow != null && p.finalHigh != null) {
        lines.push(`Итого: ${formatRub(p.finalLow)}–${formatRub(p.finalHigh)} ₽`);
      }
    }
    return lines.join('\n');
  },

  thanksCard: (p: { humanId: string; service: string; when?: string; district?: string; finalPrice?: string }) =>
    `✅ <b>Заявка #${p.humanId} принята</b>\n\n` +
    `Услуга: ${p.service}\n` +
    (p.when ? `Когда: ${p.when}\n` : '') +
    (p.district ? `Адрес: ${p.district}\n` : '') +
    (p.finalPrice ? `\nЦена со скидкой: ~${p.finalPrice} ₽\n` : '') +
    `\nМастер свяжется с вами в течение 30 минут.`,

  thanksRepeat: (p: { humanId: string; service: string; when: string; discountPercent?: number; finalPrice?: string }) =>
    `✅ <b>Готово!</b>\n\n` +
    `Заказ #${p.humanId} принят\n` +
    `Услуга: ${p.service} (повтор)\n` +
    `Когда: ${p.when}\n` +
    (p.discountPercent ? `\n🎁 Скидка постоянного клиента: −${p.discountPercent} % (применена)\n` : '') +
    (p.finalPrice ? `Цена со скидкой: ~${p.finalPrice} ₽\n` : '') +
    `\nМастер свяжется в течение 30 минут.`,

  // Мои заказы
  myOrdersHeader: '📋 <b>Мои заказы</b>',
  myOrdersEmpty:  'У вас пока нет заказов. Хотите оформить?',

  orderCard: (o: {
    humanId: string; serviceName: string;
    statusIcon: string; statusLabel: string;
    when?: string; district?: string; area?: string;
    priceQuoted?: number; discountPercent?: number;
  }) => {
    const lines: string[] = [];
    lines.push(`${o.statusIcon} <b>Заказ #${o.humanId} — ${o.serviceName}</b>\n`);
    if (o.when)     lines.push(`Дата: ${o.when}`);
    const place = [o.district, o.area].filter(Boolean).join(', ');
    if (place)      lines.push(`Адрес: ${place}`);
    lines.push(`Статус: ${o.statusLabel}`);
    if (o.priceQuoted) {
      lines.push('');
      lines.push(`Цена: ~${formatRub(o.priceQuoted)} ₽`);
      if (o.discountPercent) {
        const final = Math.round(o.priceQuoted * (1 - o.discountPercent / 100));
        lines.push(`🎁 Со скидкой постоянного клиента: ~${formatRub(final)} ₽`);
      }
    }
    return lines.join('\n');
  },

  // Реферальная программа
  referralIntro: (p: { link: string; invited: number; balance: number }) =>
    `🎁 <b>Пригласите друга — получите 500 ₽ скидки</b>\n\n` +
    `Как это работает:\n` +
    `1. Отправьте другу свою ссылку.\n` +
    `2. Он заказывает любую услугу через бота.\n` +
    `3. Когда мастер выполнит работу — вам и другу автоматически придёт по 500 ₽ скидки на следующий заказ.\n\n` +
    `Ваша ссылка:\n<code>${p.link}</code>\n\n` +
    `Друзей пригласили: <b>${p.invited}</b>\n` +
    `Доступно сейчас: <b>${p.balance} ₽</b>`,

  referralActivated: (referrerName?: string) =>
    `👋 Вас пригласил ${referrerName ?? 'друг'} — отлично!\n` +
    `Когда мастер выполнит ваш первый заказ, мы автоматически начислим 500 ₽ скидки и вам, и другу.\n\n` +
    `Что выберете?`,

  referralListEmpty: 'Пока никто не воспользовался вашей ссылкой. Поделитесь ею с соседями по даче — у вас точно есть, кто косит газон 😊',
  referralListHeader: '👥 <b>Ваши рефералы</b>',
  referralListItem: (p: { name: string; status: string; date: string }) =>
    `• ${p.name} — ${p.status === 'qualified' ? `выполнен заказ ${p.date} → +500 ₽ ✅` : 'перешёл по ссылке, ещё без заказа'}`,

  // Подсказка повторного заказа
  repeatHeader: (p: { service: string; district?: string; area?: string }) =>
    `🔁 <b>Повторяем заказ</b>\n` +
    `Услуга: ${p.service}\n` +
    (p.district ? `Адрес: ${p.district}\n` : '') +
    (p.area ? `Объём: ${p.area}\n` : '') +
    `\nКогда удобно?`,

  // Помощь
  help:
    `ℹ️ <b>Как это работает</b>\n\n` +
    `1. Выберите услугу.\n` +
    `2. Ответьте на 3–4 коротких вопроса.\n` +
    `3. Мастер позвонит подтвердить время и цену.\n` +
    `4. После работы оплачиваете на месте.\n\n` +
    `Если что-то непонятно — напишите оператору, мы рядом.`,

  // Оператор
  operator:
    `Передаю вас оператору 👨‍🔧\n` +
    `Напишите, что вас интересует — и оставьте номер. Мы перезвоним в течение 30 минут (рабочее время 9:00–21:00).`,
} as const;

// ---------------------------------------------------------------------------
// Парсеры и расчёт даты
// ---------------------------------------------------------------------------
export function parseArea(input: string): { value: number; unit: string } | null {
  const cleaned = input.toLowerCase().replace(',', '.').trim();
  const m = cleaned.match(/(\d+(?:\.\d+)?)\s*(сот|м2|м²|кв|кв\.?м|га)?/);
  if (!m) return null;
  const value = parseFloat(m[1]!);
  const unitRaw = m[2] ?? '';
  let unit = 'сотка';
  if (/м2|м²|кв/.test(unitRaw)) unit = 'м2';
  else if (/га/.test(unitRaw)) unit = 'га';
  return { value, unit };
}

export function parseAreaBucket(callbackData: string): { bucket: string; min: number; max: number; unit: string } | null {
  // 'area:lawn:5' → диапазон до 5; 'area:lawn:10' → 5–10; 'area:lawn:20' → 10–20; 'area:lawn:30' → 20+
  const m = callbackData.match(/^area:[^:]+:(\d+|custom)$/);
  if (!m) return null;
  if (m[1] === 'custom') return null;
  const top = parseInt(m[1]!, 10);
  let min = 0, max = top;
  if (top === 10) { min = 5;  max = 10; }
  else if (top === 20) { min = 10; max = 20; }
  else if (top === 30) { min = 20; max = 30; }
  return { bucket: m[1]!, min, max, unit: 'сотка' };
}

export function whenLabelToRange(label: string, today: Date = new Date()):
  { from: string; to: string; human: string } | null {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const t = new Date(today);
  switch (label) {
    case 'today':    return { from: fmt(t), to: fmt(t), human: 'сегодня' };
    case 'tomorrow': {
      const x = new Date(t); x.setDate(t.getDate() + 1);
      return { from: fmt(x), to: fmt(x), human: 'завтра' };
    }
    case 'weekend': {
      const day = t.getDay();                        // 0=Sun..6=Sat
      const sat = new Date(t); sat.setDate(t.getDate() + ((6 - day + 7) % 7));
      const sun = new Date(sat); sun.setDate(sat.getDate() + 1);
      return { from: fmt(sat), to: fmt(sun), human: 'эти выходные' };
    }
    case 'thisweek': {
      const end = new Date(t); end.setDate(t.getDate() + (7 - t.getDay()));
      return { from: fmt(t), to: fmt(end), human: 'на этой неделе' };
    }
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Старая совместимость
// ---------------------------------------------------------------------------
export function nextStep(current: Step): Step {
  const i = STEPS.indexOf(current);
  return STEPS[Math.min(i + 1, STEPS.length - 1)] as Step;
}

export function promptForStep(step: Step, k?: ServiceKind): string {
  switch (step) {
    case 'service':     return 'Выберите услугу из меню.';
    case 'area':        return k ? TEXT.serviceSelected(k) : TEXT.unknown;
    case 'district':    return TEXT.askDistrict;
    case 'description': return TEXT.askDescription;
    case 'photos':      return TEXT.askPhotos;
    case 'date':        return TEXT.askDate;
    case 'phone':       return TEXT.askPhone;
    case 'done':        return k ? TEXT.thanks(k) : 'Готово.';
  }
}

// ---------------------------------------------------------------------------
// Вспомогательные форматтеры
// ---------------------------------------------------------------------------
export function formatRub(n: number): string {
  return n.toLocaleString('ru-RU').replace(/ /g, ' ');
}

export function formatDateRange(from?: string | null, to?: string | null): string {
  if (!from) return '';
  if (!to || to === from) return formatDate(from);
  return `${formatDate(from)} — ${formatDate(to)}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

// Расчёт ценового коридора по услуге и площади/штукам
export function estimatePriceRange(
  k: ServiceKind, units: number,
): { low: number; high: number } {
  const r = PRICE_RANGE[k];
  const low  = Math.max(r.minOrder ?? 0, Math.round(r.min * units));
  const high = Math.max(r.minOrder ?? 0, Math.round(r.max * units));
  return { low, high };
}

export function applyDiscountToRange(
  price: { low: number; high: number },
  percent: number,
  bonusRub: number,
): { low: number; high: number } {
  const after = (n: number) => Math.max(0, Math.round(n * (1 - percent / 100)) - bonusRub);
  return { low: after(price.low), high: after(price.high) };
}
