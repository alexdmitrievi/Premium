// Машина состояний для воронок Telegram/MAX-ботов.
// Один пользователь = одна сессия (см. таблицу bot_sessions).
// Шаги детерминированные: получили событие → определили текущий step
// → собрали ответ + новый step + патч state.

import type { ServiceKind } from './supabase';

export type FunnelId = 'main' | ServiceKind | 'operator';

export type SessionState = {
  serviceKind?: ServiceKind;
  area?: number;
  areaUnit?: string;
  district?: string;
  address?: string;
  description?: string;
  desiredDate?: string;
  phone?: string;
  // ассеты (file_id Telegram / external_url MAX)
  mediaIds?: string[];
};

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

// Тексты приветствия / меню — выносим, чтобы переиспользовать в Telegram и MAX.
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

  askDistrict:    'В каком районе/посёлке участок? (например: «Чкаловский», «Ясная Поляна»)',
  askDescription: 'Коротко опишите задачу: что нужно сделать, есть ли сложности (склон, кусты, мусор и т.п.).',
  askPhotos:      'Если есть, отправьте 1–3 фото объекта. Если фото не нужны — нажмите «Пропустить».',
  askDate:        'Когда удобно приехать? Любая дата или диапазон, например «эти выходные», «10–12 мая».',
  askPhone:       'И последний шаг — телефон, чтобы мастер связался для подтверждения. Можно нажать кнопку ниже.',
  thanks:         (k: ServiceKind) =>
    `Спасибо! Заявка на «${SERVICE_LABEL[k]}» принята ✅\n` +
    `Мастер свяжется с вами в ближайший рабочий час, обычно в течение 30 минут.\n\n` +
    `Если хотите добавить что-то — просто напишите в этот чат.`,

  operator:
    `Передаю вас оператору 👨‍🔧\n` +
    `Напишите, пожалуйста, что вас интересует — и оставьте номер. ` +
    `Мы перезвоним в течение 30 минут (рабочее время 9:00–21:00).`,

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

// Шаги воронки — общий порядок для всех услуг.
export const STEPS = ['service', 'area', 'district', 'description', 'photos', 'date', 'phone', 'done'] as const;
export type Step = (typeof STEPS)[number];

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

// Простой парсер площади из произвольного текста.
export function parseArea(input: string): { value: number; unit: string } | null {
  const cleaned = input.toLowerCase().replace(',', '.').trim();
  const m = cleaned.match(/(\d+(?:\.\d+)?)\s*(сот|м2|м²|кв|кв\.?м|га)?/);
  if (!m) return null;
  const value = parseFloat(m[1]);
  const unitRaw = m[2] ?? '';
  let unit = 'сотка';
  if (/м2|м²|кв/.test(unitRaw)) unit = 'м2';
  else if (/га/.test(unitRaw)) unit = 'га';
  return { value, unit };
}
