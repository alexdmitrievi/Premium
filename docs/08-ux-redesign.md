# 08. UX-редизайн ботов: аудит → новая концепция → реферальная программа и лояльность

Этот документ — продолжение `docs/05-funnels.md`, после которого мы:

1. Делаем аудит текущей версии (что есть в `lib/funnels.ts`, `api/telegram/webhook.ts`, `api/max/webhook.ts`).
2. Перерисовываем главный экран и воронки в Telegram и MAX.
3. Добавляем разделы «Мои заказы», «Повторить заказ», «Реферальная программа», «Бонусы».
4. Описываем изменения в БД (таблицы и RPC).
5. Описываем изменения в коде (`lib/funnels.ts`, обработчики).
6. Дополняем n8n-воркфлоу.

> Цель — превратить бот из «формы из 7 вопросов» в продукт, в котором клиент за 1–2 клика может повторить заказ, видит свою скидку и понимает, как пригласить друга.

---

## Шаг 1. Аудит текущего UX

### 1.1. Что сейчас происходит

После `/start` пользователь видит **5 inline-кнопок**: 4 услуги + «Связаться с оператором»
(см. `lib/telegram.ts → mainMenuKeyboard()`). Дальше любая услуга идёт по жёсткой
цепочке шагов, описанной в `lib/funnels.ts`:

```
service → area → district → description → photos → date → phone → done
```

Состояние в `bot_sessions.state`:
- `serviceKind`, `area`, `areaUnit`, `district`, `description`,
  `desiredDate`, `phone`, `mediaIds[]`.

Статусы лида в `leads.status` (см. ENUM `lead_status`):
`new → qualifying → qualified → quoted → scheduled → in_progress → done`,
плюс `lost` и `archived`.

### 1.2. Что хорошо

- Идемпотентность — `webhook_inbox` + дубль-проверка, работает в обоих ботах.
- Машина состояний — простая, на одной таблице, без локальной памяти.
- Воронка одинаковая для всех услуг, что упрощает поддержку.
- В Supabase уже есть `traffic_sources`, `events`, `tags` — фундамент под лояльность готов.

### 1.3. Слабые места UX (что чиним)

| Проблема                               | Где видно                              | Как чиним                                                  |
|----------------------------------------|----------------------------------------|-------------------------------------------------------------|
| **«Тупик» в `done`**: пользователю предлагают только написать `/start`, нет CTA «новая заявка» / «мои заказы». | `advanceFunnel.case 'done'` в `webhook.ts:281`. | Добавляем «карточку успеха» с 3 кнопками: ✅ Готово / 🔁 Повторить / 📋 Мои заказы. |
| **Нет «Мои заказы»**: клиент не видит свою историю, не понимает, на каком этапе мастер. | Главное меню. | Новый раздел «📋 Мои заказы» со списком последних 5 заявок и статусом каждой. |
| **Нет повторного заказа в один клик**. | Везде. После первой заявки клиент идёт через те же 6 вопросов. | «🔁 Повторить заказ» в карточке заказа: показывает прежние параметры → подтверждение/изменение даты → готово. |
| **Шаг `district`** — свободный ввод текстом, на проде даст много мусора («Где-то за городом»). | `case 'district'` в `webhook.ts:202`. | Превращаем в выбор inline-кнопок: 5 ключевых районов Омска + «Другое» с текстом. |
| **Шаг `date`** — свободный ввод, парсить «эти выходные» сложно. | `case 'date'` в `webhook.ts:234`. | inline-чипсы: «Сегодня», «Завтра», «На этой неделе», «На следующей», «Другая дата» (свободный ввод). |
| **Шаг `phone`** — даже после `request_contact` клиент часто шлёт текст. | `case 'phone'` в `webhook.ts:242`. | Если уже есть телефон в `contacts.phone` — пропускаем шаг и сразу `done`. |
| **Длинные welcome-тексты** с эмодзи в каждой строке. Создаёт ощущение «маркетинг», а не сервиса. | `TEXT.welcome` в `funnels.ts:49`. | Короткое 2-сообщения приветствие + кнопки. Тексты для MAX — без эмодзи в шапке. |
| **Отсутствует визуальный «итог»**. Перед созданием лида клиент не видит, что он заказал. | Между `phone` и `done`. | Новый шаг `confirm` — карточка с резюме («Покос, 8 соток, Чкаловский, 11 мая»), кнопки «✅ Подтвердить» / «✏️ Изменить». |
| **Смешанные цели в `op:contact`**: и «вопрос», и «срочный звонок». | `webhook.ts:144`. | Делим на «Задать вопрос» (текстовый чат с оператором) и «Перезвоните мне» (просто отдаёт номер). |
| **Нет лояльности и реферальной программы**. | Везде. | Новые разделы и таблицы (см. шаг 3). |
| **Нет показа цены в финале**. После `done` клиент не понимает, сколько он заплатит. | `TEXT.thanks` в `funnels.ts:69`. | В карточке резюме показываем коридор цены и применённую скидку. |

---

## Шаг 2. Новый UX (Telegram + MAX)

Принципы:

- В каждый момент времени у клиента **3–4 кнопки**, не больше. Если выбор шире — последняя кнопка «Другое» с открытым вводом.
- Любой экран должен отвечать на 3 вопроса: «Где я?», «Что мне сделать?», «Как назад?».
- Никаких «введите команду» — все переходы кнопками.
- Тексты в Telegram — лёгкие, дружеские, с эмодзи в начале строки.
- Тексты в MAX — нейтральные, чуть более официальный тон, эмодзи только функциональные (✓, ✖, →), без декора.
- Резюме перед отправкой — обязательно. Это снимает 80 % правок постфактум.
- В каждом ответе бота, кроме самих вопросов, всегда есть либо «📋 Мои заказы», либо «🏠 Меню» — клиент никогда не «застревает».

### 2.1. Главный экран

#### Telegram

Сообщение 1 (короткое приветствие):

```
👋 Здравствуйте, {имя}!
Я — бот «Премиум — уход за участком». Помогу заказать работы по дому и
участку в Омске за пару минут.
```

Сообщение 2 (меню) с inline-клавиатурой:

```
Что вас интересует?
```

Кнопки (2 колонки, чтобы не растягивать экран):

```
[ 🌱 Покос ]            [ 🌿 Скарификация ]
[ 🪓 Расчистка ]        [ 🏊 Бассейн ]
─────────────────────────────────────────
[ 📋 Мои заказы ]       [ 🎁 Пригласить друга ]
─────────────────────────────────────────
[ ❔ Помощь ]           [ ☎️ Связь с оператором ]
```

`callback_data`:

| Кнопка                  | callback_data            |
|-------------------------|--------------------------|
| Покос                   | `svc:lawn_mowing`        |
| Скарификация            | `svc:scarification`      |
| Расчистка               | `svc:land_clearing`      |
| Бассейн                 | `svc:pool_cleaning`      |
| Мои заказы              | `nav:orders`             |
| Пригласить друга        | `nav:referral`           |
| Помощь                  | `nav:help`               |
| Связь с оператором      | `nav:operator`           |

#### MAX

Те же кнопки, но один блок-сообщение и без декора:

```
Здравствуйте, {имя}.
Бот «Премиум — уход за участком», Омск.
Выберите услугу или раздел.
```

Кнопки `inline_keyboard` — те же payload'ы, текст без эмодзи в начале:
`Покос газона`, `Скарификация и аэрация`, `Расчистка участка`,
`Бассейн`, `Мои заказы`, `Пригласить друга`, `Помощь`, `Оператор`.

### 2.2. Воронки по 4 услугам — единый редизайн

Цель — уложить любую услугу **в 4–6 шагов**. После выбора услуги:

```
1. service       (выбрана из меню)
2. params        (ключевой параметр услуги: соток / м³ / штук)  ← заменяет area
3. district      (5 кнопок + «Другое»)
4. when          (5 кнопок «Сегодня», «Завтра», «Эти выходные», «На неделе», «Другое»)
5. photos*       (опционально, только для расчистки и бассейна; кнопка «Пропустить»)
6. confirm       (карточка с резюме + телефон один раз; повторно не спрашиваем)
```

`*` Шаг `photos` остаётся **только** для услуг, где фото реально влияет на оценку: `land_clearing`, `tree_cutting`, `stump_removal`, `pool_cleaning`, `pool_assembly`. Для `lawn_mowing`/`scarification`/`aeration` фото нет — там и так одна сотка одинакова.

#### 2.2.1. Покос газона — пример (Telegram)

> Сценарий нового клиента, телефона ещё нет.

**Шаг 1.** (после `svc:lawn_mowing`)

```
🌱 Покос газона
Стандартная цена: 250–600 ₽ за сотку (зависит от высоты травы).

Какая площадь вашего газона?
```

Кнопки:

```
[ до 5 соток ] [ 5–10 ]
[ 10–20 ]      [ 20+ ]
[ ✏️ Указать вручную ]
[ ◀️ В меню ]
```

`callback_data`: `area:lawn:5`, `area:lawn:10`, `area:lawn:20`, `area:lawn:30`, `area:lawn:custom`, `nav:home`.

**Шаг 2.** «Где находится участок?»

```
В каком районе участок?
```

Кнопки (2 колонки):

```
[ Чкаловский ]    [ Кировский ]
[ Ленинский ]     [ Октябрьский ]
[ Советский ]     [ ✏️ Другое ]
[ ◀️ Назад ]
```

`callback_data`: `dist:chkalovskiy` … `dist:other`, `back`.

**Шаг 3.** «Когда удобно?»

```
Когда удобно приехать?
```

Кнопки:

```
[ Сегодня ]         [ Завтра ]
[ Эти выходные ]    [ На этой неделе ]
[ ✏️ Другая дата ]
[ ◀️ Назад ]
```

`callback_data`: `when:today`, `when:tomorrow`, `when:weekend`, `when:thisweek`, `when:custom`.

**Шаг 4.** Резюме (новый шаг `confirm`)

```
✅ Проверьте, всё верно?

Услуга: Покос газона
Площадь: 5–10 соток
Район: Чкаловский
Когда: эти выходные

Цена: 1 250 – 6 000 ₽ (точно скажет мастер на месте)
{если есть скидка}: 🎁 Ваша скидка по программе лояльности: −10 % (повторный заказ)
```

Кнопки:

```
[ ✅ Подтвердить ]
[ ✏️ Изменить дату ] [ ✏️ Изменить район ]
[ ❌ Отменить ]
```

`callback_data`: `confirm:ok`, `edit:when`, `edit:district`, `confirm:cancel`.

**Шаг 5.** Если телефона ещё нет — один экран на сбор номера; если есть — пропускаем сразу к финалу.

```
Последний шаг — телефон, чтобы мастер позвонил подтвердить время.
```

Кнопка `request_contact`: «📞 Поделиться номером», плюс «✏️ Ввести вручную».

**Шаг 6.** Финал — карточка успеха.

```
✅ Заявка #A-1042 принята

Услуга: Покос газона
Когда: эти выходные
Адрес: Чкаловский район

Мастер свяжется с вами в течение 30 минут (обычно быстрее).
```

Кнопки:

```
[ 📋 Мои заказы ]
[ 🎁 Пригласить друга и получить скидку ]
[ 🏠 В меню ]
```

#### 2.2.2. Скарификация / аэрация

В шаге 1 — **дополнительная развилка** (одна услуга или обе):

```
🌿 Скарификация и аэрация газона
Что нужно?
```

```
[ Скарификация ]
[ Аэрация ]
[ Скарификация + аэрация (рекомендуется) ]
[ ◀️ В меню ]
```

`callback_data`: `svc:scarification`, `svc:aeration`, `svc:scarification+aeration`, `nav:home`.

Дальше шаги 2–6 как у покоса (площадь → район → когда → резюме → телефон → финал).

#### 2.2.3. Расчистка участка

В шаге 1 — выбор подзадачи (одна или несколько чекбоксов):

```
🪓 Расчистка участка
Что нужно сделать?
(можно выбрать несколько)
```

Кнопки multiselect (через переключающиеся `cb:land:tree`, `cb:land:stump`, `cb:land:debris`, `cb:land:overgrowth`):

```
[ ☐ Покос бурьяна ]
[ ☐ Спил деревьев и веток ]
[ ☐ Корчевание пней ]
[ ☐ Уборка и вывоз мусора ]
[ ✅ Готово, дальше ]
```

После — площадь / количество (зависит от выбора), район, дата, **обязательное фото или 1 выбранная опция «Описать словами»**, резюме, телефон, финал.

`service_kind` определяется по выбранному набору: если выбрано только «Спил» → `tree_cutting`, иначе `land_clearing` с подробностями в `metadata.subtasks[]`.

#### 2.2.4. Бассейн

Шаг 1: «Что нужно?»

```
🏊 Бассейн
Какая нужна услуга?
```

```
[ Чистка / запуск на лето ]
[ Сборка и запуск нового ]
[ Консервация на зиму ]
[ ✏️ Не уверен, опишу словами ]
[ ◀️ В меню ]
```

`callback_data`: `svc:pool_cleaning`, `svc:pool_assembly`, `svc:pool_winter`, `svc:pool_other`.

Дальше: размер бассейна (кнопки: «До 3 м³», «3–10», «10+», «Не знаю»), район, дата, фото (рекомендуется), резюме, телефон, финал.

### 2.3. Раздел «Мои заказы»

Из главного меню → `nav:orders`.

```
📋 Мои заказы
```

Если заказов нет:

```
У вас пока нет заказов. Хотите оформить?
```

```
[ 🌱 Покос ] [ 🌿 Скарификация ]
[ 🪓 Расчистка ] [ 🏊 Бассейн ]
[ 🏠 В меню ]
```

Если заказы есть — список последних 5 (одно сообщение = одна карточка):

```
🟢 Заказ #A-1042 — Покос газона
Дата: эти выходные
Адрес: Чкаловский р-н, 5–10 соток
Статус: согласован, мастер приедет в субботу 11 мая, 10:00
Цена: ~3 200 ₽
```

Кнопки на карточке:

```
[ 📞 Связаться ]
[ ✏️ Изменить дату ]
[ ❌ Отменить ]
[ 🔁 Повторить такой же ]
```

`callback_data`: `lead:contact:<id>`, `lead:edit_date:<id>`, `lead:cancel:<id>`, `lead:repeat:<id>`.

После всех карточек одно служебное сообщение со списком:

```
[ 🏠 В меню ]
```

#### Маппинг внутренних статусов → пользовательских

Внутри `leads.status` мы храним технические значения; пользователю показываем человеческие:

| `lead_status`                | Текст в UI                                | Иконка |
|------------------------------|-------------------------------------------|--------|
| `new`                        | Принят, обрабатываем                     | 🟡 |
| `qualifying` / `qualified`   | Уточняем детали, скоро согласуем          | 🟡 |
| `quoted`                     | Цена согласована, ждём подтверждения дня  | 🟢 |
| `scheduled`                  | Согласован, мастер приедет {date}         | 🟢 |
| `in_progress`                | Мастер сейчас на объекте                  | 🔵 |
| `done`                       | Выполнен ✓                                | ✅ |
| `lost`                       | Отменён                                   | ⚪ |
| `archived`                   | (не показываем)                           | — |

#### Отмена/изменение

- Отменить можно только в статусах `new`, `qualifying`, `qualified`, `quoted`, `scheduled` (до фактического выезда). После — кнопка скрыта, остаётся «📞 Связаться».
- Изменить дату — кнопка вызывает мини-сценарий: «Когда удобно?» (5 кнопок) → апдейт `leads.desired_date_*` и `metadata.desired_date_label`. Никаких новых заявок не создаём — это `update`, не `insert`.

### 2.4. Повторный заказ — 1–2 клика

Кнопка `🔁 Повторить такой же` на карточке выполненного (или активного) заказа запускает короткую воронку:

```
🔁 Повторяем заказ
Услуга: Покос газона
Адрес: Чкаловский р-н, 5–10 соток

Когда удобно?
```

Только один вопрос — дата. После выбора:

```
✅ Готово!

Заказ #A-1057 принят
Услуга: Покос газона (повтор)
Когда: эти выходные

🎁 Скидка постоянного клиента: −10 % (применена)
```

Кнопки:

```
[ 📋 Мои заказы ]   [ 🏠 В меню ]
```

Реализация: всё то же `create_lead`, но с пред-заполненными полями из старой
заявки + автоприменение скидки (см. шаг 3.2). В `events` пишется
`lead.created` с `metadata.repeat_of = <old lead_id>`.

### 2.5. Помощь и оператор

`nav:help`:

```
ℹ️ Как это работает

1) Выберите услугу.
2) Ответьте на 3–4 коротких вопроса.
3) Мастер позвонит подтвердить время и цену.
4) После работы оплачиваете на месте.

Если что-то непонятно — напишите оператору, мы рядом.
```

Кнопки:

```
[ ☎️ Перезвоните мне ]
[ 💬 Написать оператору ]
[ 🏠 В меню ]
```

`nav:operator` (после нажатия из меню) → две кнопки выбора:
«Перезвоните мне» (запрашиваем телефон, кладём `lead.kind = 'callback'` или
просто пишем событие `event.type='callback_request'`) и «Написать оператору» (включаем режим
human-handoff: ставим тег `human_handoff` контакту и через n8n
форвардим переписку владельцу).

---

## Шаг 3. Реферальная программа и лояльность

Принципы:

- Один экран — один смысл.
- Без уровней, без «уровень бронзы за 5 заказов и серебра за 10». Только две понятные механики:
  1. **Реферал** — пригласил друга, друг сделал заказ → каждому по 500 ₽ скидки.
  2. **Повторный заказ** — каждый следующий заказ дешевле на фиксированный %.
- Скидка применяется **автоматически** при создании заказа. Пользователю достаточно её увидеть.

### 3.1. Реферальная программа

#### Как пользователь это видит

Из меню → `nav:referral`:

```
🎁 Пригласите друга — получите 500 ₽ скидки

Как это работает:
1) Отправьте другу вашу ссылку.
2) Он заказывает любую услугу через бота.
3) Когда мастер выполнит работу — вам и другу автоматически придёт по 500 ₽ скидки на следующий заказ.

Ваша ссылка:
https://t.me/premium_omsk_bot?start=ref_AB1234

Друзей пригласили: 2
Скидок начислено: 1 000 ₽
Скидок использовано: 500 ₽
Доступно сейчас: 500 ₽
```

Кнопки:

```
[ 📤 Поделиться ссылкой ]   ← deep-link через Telegram share
[ 📋 Мои рефералы ]         ← список людей, которые перешли
[ 🏠 В меню ]
```

Подкнопка «📋 Мои рефералы»:

```
👥 Ваши рефералы

• Пользователь A — заказал Покос 28 апреля → +500 ₽ ✅
• Пользователь B — перешёл по ссылке 5 мая, ещё без заказа

Когда друг сделает первый заказ и мастер выполнит работу — вы получите 500 ₽.
```

#### MAX — то же содержание, без эмодзи в шапке

```
Программа «Приведи друга»

Вы получаете 500 ₽ скидки на следующий заказ за каждого друга, который воспользуется ботом.

Ваша ссылка:
https://max.ru/premium_omsk_bot?start=ref_AB1234
```

#### Как это устроено в БД

Новые таблицы (см. миграцию `20260507000004_loyalty_referrals.sql`):

- `referral_codes` — `id`, `contact_id`, `code` (короткий: `AB1234`), `created_at`, `is_active`.
- `referrals` — `id`, `referrer_contact_id`, `invitee_contact_id`,
  `referral_code_id`, `qualifying_lead_id` (NULL пока друг не выполнил заказ),
  `status` (`pending` / `qualified` / `expired`), `created_at`, `qualified_at`.

Бизнес-правила:

1. Один реферальный код на контакт. При первом обращении к разделу — создаём через `ensure_referral_code(contact_id)`.
2. При `/start ref_<code>` от **нового** клиента в боте:
   - Vercel-handler парсит payload, ищет `referral_codes.code = 'AB1234'`.
   - Если у нового контакта ещё нет `referral_id` — создаём `referrals(referrer, invitee, status='pending')`.
   - Если код принадлежит самому клиенту (self-invite) — игнорируем.
   - Если у клиента уже был активный referral — не перезаписываем (anti-fraud: тот, кто пригласил первым, забирает бонус).
3. Когда у `invitee` появляется первый `lead.status='done'` — n8n-воркфлоу
   `05-referral-loyalty.json`:
   - Вызывает RPC `qualify_referral(p_invitee_contact_id, p_lead_id)`,
   - который меняет `referrals.status='qualified'`, ставит `qualified_at`,
   - и пишет два события `loyalty.bonus_granted` (по 500 ₽: рефереру и приглашённому).
4. Бонусы — записи в новой таблице `loyalty_balances` (см. шаг 3.2).

#### Anti-fraud мини-набор (на старте можно не накручивать)

- Один телефон / один Telegram-id = один контакт (это уже обеспечено уникальностью `contact_identities (channel, external_id)` и нормализацией телефона).
- Реферальный бонус начисляется **только после фактического `done`** заказа, не после `new`. Закрывает массовое «друг сделал заявку → отменил».
- Реферальный код, выданный самому себе, не принимается. Сравниваем `referrer_contact_id != invitee_contact_id` в `qualify_referral`.

### 3.2. Лояльность за повторные заказы

#### Простая логика

| Заказ                  | Скидка                                      |
|------------------------|---------------------------------------------|
| 1-й                    | 0 %                                         |
| 2-й                    | 5 %                                         |
| 3-й и далее            | 10 %                                        |
| + Реферальный бонус    | до −500 ₽ от итога (один раз)              |

Скидка считается над **`done`-заказами в текущем календарном году**, чтобы клиент не «пожизненно сидел на 10 %», а возвращался каждый сезон.

#### Где хранить

- В `contacts` добавляем поле `loyalty_tier text default 'standard'` — на будущее (`vip`, `partner`).
- Новая таблица `loyalty_balances` — `contact_id pk`, `bonus_rub int`, `updated_at`.
- Новая таблица `loyalty_events` — лог изменений баланса (`+500` / `-300` / `expired`).
- В `leads` добавляем `discount_percent int default 0`, `discount_rub int default 0` — фактически применённая скидка (для исторической точности).

#### UX в боте

При создании заказа на шаге `confirm` мы вызываем RPC
`compute_discount_for_contact(p_contact_id, p_service_kind)` → возвращает
`{percent, rub_bonus}` и подставляем строку:

```
🎁 Ваша скидка: −10 % (постоянный клиент) и −500 ₽ (реферальный бонус)
Итого ориентировочно: 2 250 ₽
```

После подтверждения:
- скидка фиксируется в `leads.discount_percent` и `leads.discount_rub`,
- бонусные рубли списываются (`loyalty_events: -500`, `loyalty_balances` уменьшается).
- если позже заказ перешёл в `lost` — n8n триггерит RPC `refund_bonus(p_lead_id)` и возвращает баланс.

#### Где пользователь видит баланс

В разделе «🎁 Пригласить друга» (внизу карточки) и в «📋 Мои заказы» рядом с активным заказом:
```
Доступно бонусов: 500 ₽
```

### 3.3. Готовые тексты сообщений

```
referralIntro:
🎁 Пригласите друга — получите 500 ₽ скидки

Как это работает:
1) Отправьте другу вашу ссылку.
2) Он заказывает любую услугу через бота.
3) Когда мастер выполнит работу — вам и другу автоматически придёт по 500 ₽ скидки на следующий заказ.

Ваша ссылка:
{link}

Друзей пригласили: {count}
Доступно сейчас: {balance} ₽
```

```
referralActivated (отправляем приглашённому при /start ref_*):
👋 Вас пригласил {referrerName} — отлично!
Когда мастер выполнит ваш первый заказ, мы автоматически начислим 500 ₽ скидки и вам, и другу.

Что выберете?
[ 🌱 Покос ] [ 🌿 Скарификация ]
[ 🪓 Расчистка ] [ 🏊 Бассейн ]
```

```
loyaltyApplied (на шаге confirm у клиента со скидкой):
🎁 Сегодня для вас действует скидка постоянного клиента: −{percent} %
{если есть реферальный бонус}: и реферальный бонус −{rub} ₽.
Итого ориентировочно: {total} ₽.
```

```
referralQualified (приходит обоим, когда заказ выполнен):
✅ {friendName}, ваш друг выполнил заказ!
На ваш счёт начислено 500 ₽ — скидка применится автоматически в следующем заказе.

[ 🌱 Заказать сейчас ]   [ 🏠 В меню ]
```

```
firstRepeatHint (пушим через 14 дней после первого выполненного заказа, если нет повторов):
🌱 Здравствуйте! Прошло две недели с прошлого покоса — газон уже подрос.
Хотите снова? Для вас сейчас действует скидка −5 % как постоянному клиенту.

[ 🔁 Повторить заказ ]   [ 🏠 В меню ]
```

---

## Шаг 4. Конкретные изменения в коде и БД

### 4.1. Supabase: миграция `20260507000004_loyalty_referrals.sql`

См. файл — он добавлен. Кратко содержимое:

```sql
-- 1. Поля в contacts
alter table public.contacts
  add column if not exists loyalty_tier text not null default 'standard',
  add column if not exists total_orders int not null default 0,
  add column if not exists last_order_at timestamptz;

-- 2. Поля в leads
alter table public.leads
  add column if not exists discount_percent int not null default 0,
  add column if not exists discount_rub int not null default 0,
  add column if not exists repeat_of uuid references public.leads(id) on delete set null,
  add column if not exists referral_id uuid;  -- FK добавим ниже

-- 3. Реферальные коды
create table public.referral_codes (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null unique references public.contacts(id) on delete cascade,
  code text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 4. Реферальные связи
create type referral_status as enum ('pending','qualified','expired');
create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_contact_id uuid not null references public.contacts(id) on delete cascade,
  invitee_contact_id  uuid not null references public.contacts(id) on delete cascade,
  referral_code_id    uuid not null references public.referral_codes(id),
  qualifying_lead_id  uuid references public.leads(id),
  status referral_status not null default 'pending',
  created_at  timestamptz not null default now(),
  qualified_at timestamptz,
  unique (invitee_contact_id) -- один приглашающий на одного приглашённого
);

alter table public.leads
  add constraint leads_referral_fk foreign key (referral_id) references public.referrals(id);

-- 5. Балансы и события лояльности
create table public.loyalty_balances (
  contact_id uuid primary key references public.contacts(id) on delete cascade,
  bonus_rub int not null default 0,
  updated_at timestamptz not null default now()
);

create table public.loyalty_events (
  id bigserial primary key,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  delta_rub int not null,
  reason text not null,                   -- 'referral_qualified' | 'order_applied' | 'refund' | 'expired'
  related_lead_id uuid references public.leads(id),
  related_referral_id uuid references public.referrals(id),
  created_at timestamptz not null default now()
);

create index idx_loyalty_events_contact on public.loyalty_events(contact_id, created_at desc);
```

И RPC:

```sql
-- ensure_referral_code: возвращает код или создаёт.
-- Код: 6 знаков [A-Z0-9], легко ввести.
create or replace function public.ensure_referral_code(p_contact_id uuid)
returns text language plpgsql security definer as $$
declare v_code text;
begin
  select code into v_code from public.referral_codes where contact_id = p_contact_id;
  if v_code is not null then return v_code; end if;

  loop
    v_code := upper(substring(md5(gen_random_uuid()::text) for 6));
    begin
      insert into public.referral_codes (contact_id, code) values (p_contact_id, v_code);
      return v_code;
    exception when unique_violation then
      -- крайне редкий шанс коллизии; пробуем ещё раз
      continue;
    end;
  end loop;
end $$;

-- record_referral_visit: вызывается из Vercel при /start ref_<code>
create or replace function public.record_referral_visit(p_invitee_contact_id uuid, p_code text)
returns uuid language plpgsql security definer as $$
declare v_rc record; v_id uuid;
begin
  select * into v_rc from public.referral_codes where code = p_code and is_active;
  if v_rc.id is null then return null; end if;
  if v_rc.contact_id = p_invitee_contact_id then return null; end if;

  insert into public.referrals (referrer_contact_id, invitee_contact_id, referral_code_id, status)
  values (v_rc.contact_id, p_invitee_contact_id, v_rc.id, 'pending')
  on conflict (invitee_contact_id) do nothing
  returning id into v_id;

  return v_id;
end $$;

-- qualify_referral: вызывается, когда у invitee первый lead перешёл в done
create or replace function public.qualify_referral(
  p_invitee_contact_id uuid,
  p_lead_id uuid,
  p_bonus_rub int default 500
) returns void language plpgsql security definer as $$
declare v_ref record;
begin
  select * into v_ref from public.referrals
   where invitee_contact_id = p_invitee_contact_id and status = 'pending' for update;
  if v_ref.id is null then return; end if;

  update public.referrals
     set status = 'qualified', qualified_at = now(), qualifying_lead_id = p_lead_id
   where id = v_ref.id;

  perform public.grant_bonus(v_ref.referrer_contact_id, p_bonus_rub, 'referral_qualified', null, v_ref.id);
  perform public.grant_bonus(v_ref.invitee_contact_id,  p_bonus_rub, 'referral_qualified', null, v_ref.id);
end $$;

-- grant_bonus / spend_bonus
create or replace function public.grant_bonus(
  p_contact_id uuid, p_amount int, p_reason text,
  p_lead_id uuid default null, p_ref_id uuid default null
) returns void language plpgsql security definer as $$
begin
  insert into public.loyalty_balances (contact_id, bonus_rub) values (p_contact_id, p_amount)
  on conflict (contact_id) do update
  set bonus_rub = public.loyalty_balances.bonus_rub + excluded.bonus_rub,
      updated_at = now();

  insert into public.loyalty_events (contact_id, delta_rub, reason, related_lead_id, related_referral_id)
  values (p_contact_id, p_amount, p_reason, p_lead_id, p_ref_id);
end $$;

create or replace function public.spend_bonus(
  p_contact_id uuid, p_amount int, p_lead_id uuid
) returns int language plpgsql security definer as $$
declare v_balance int;
begin
  select bonus_rub into v_balance from public.loyalty_balances where contact_id = p_contact_id for update;
  v_balance := coalesce(v_balance, 0);
  if v_balance <= 0 or p_amount <= 0 then return 0; end if;

  declare v_used int := least(v_balance, p_amount);
  begin
    update public.loyalty_balances
       set bonus_rub = bonus_rub - v_used, updated_at = now()
     where contact_id = p_contact_id;
    insert into public.loyalty_events (contact_id, delta_rub, reason, related_lead_id)
    values (p_contact_id, -v_used, 'order_applied', p_lead_id);
    return v_used;
  end;
end $$;

-- compute_discount_for_contact
create or replace function public.compute_discount_for_contact(
  p_contact_id uuid, p_service_kind service_kind
) returns table (percent int, rub_bonus int) language plpgsql stable as $$
declare v_orders int; v_balance int;
begin
  select count(*) into v_orders
    from public.leads l
   where l.contact_id = p_contact_id
     and l.status = 'done'
     and l.completed_at >= date_trunc('year', now());

  select bonus_rub into v_balance from public.loyalty_balances where contact_id = p_contact_id;
  v_balance := coalesce(v_balance, 0);

  if v_orders >= 2 then percent := 10;
  elsif v_orders = 1 then percent := 5;
  else percent := 0; end if;

  rub_bonus := v_balance;
  return next;
end $$;

-- bump_total_orders: триггер на leads, чтобы держать total_orders/last_order_at в актуале
create or replace function public.tg_bump_total_orders()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'UPDATE' and new.status = 'done' and (old.status is distinct from 'done')) then
    update public.contacts
       set total_orders = total_orders + 1,
           last_order_at = coalesce(new.completed_at, now())
     where id = new.contact_id;
  end if;
  return new;
end $$;

drop trigger if exists bump_total_orders on public.leads;
create trigger bump_total_orders after update on public.leads
  for each row execute function public.tg_bump_total_orders();
```

### 4.2. Расширение `lib/funnels.ts`

Идея: добавляем второй слой состояний (экраны), который ортогонален «6 шагов воронки услуги».

```ts
// Новые экраны верхнего уровня
export type Screen =
  | 'home'
  | 'order'        // воронка заказа (внутри неё — Step из старого STEPS, плюс новые 'params'|'confirm')
  | 'orders'       // список «Мои заказы»
  | 'order_card'   // конкретный заказ
  | 'repeat'       // быстрый повтор
  | 'edit_date'    // изменение даты существующего заказа
  | 'referral'     // экран реферальной программы
  | 'help'
  | 'operator';

// Новый тип Step внутри order-воронки
export const ORDER_STEPS = [
  'service', 'params', 'district', 'when', 'photos', 'confirm', 'phone', 'done',
] as const;
export type OrderStep = (typeof ORDER_STEPS)[number];

// Расширенный SessionState
export type SessionState = {
  screen?: Screen;
  // когда screen='order':
  serviceKind?: ServiceKind;
  serviceVariant?: 'scarification' | 'aeration' | 'scarification+aeration';
  poolKind?: 'pool_cleaning' | 'pool_assembly' | 'pool_winter' | 'pool_other';
  landSubtasks?: Array<'overgrowth' | 'tree' | 'stump' | 'debris'>;
  area?: number;
  areaUnit?: string;
  district?: string;
  districtCode?: string;
  whenLabel?: string;        // 'today' | 'tomorrow' | 'weekend' | 'thisweek' | 'custom'
  whenCustom?: string;       // если 'custom'
  description?: string;
  mediaIds?: string[];
  phone?: string;
  // во время confirm
  discountPercent?: number;
  bonusRub?: number;
  // если screen='order_card' / 'repeat' / 'edit_date'
  activeLeadId?: string;
};
```

Парсеры расширяем:

```ts
export function parseAreaBucket(callbackData: string): { value: number; unit: string } | null {
  // 'area:lawn:5' → 5 соток (нижняя граница диапазона "до 5")
  const m = callbackData.match(/^area:[^:]+:(\d+|custom)$/);
  if (!m || m[1] === 'custom') return null;
  return { value: parseInt(m[1], 10), unit: 'сотка' };
}

export function whenLabelToDateRange(label: string, today = new Date()):
  { from: string; to: string; human: string } | null {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const t = new Date(today);
  switch (label) {
    case 'today':    return { from: fmt(t), to: fmt(t), human: 'сегодня' };
    case 'tomorrow': { const x = new Date(t); x.setDate(t.getDate()+1); return { from: fmt(x), to: fmt(x), human: 'завтра' }; }
    case 'weekend': {
      const day = t.getDay();                  // 0=Sun..6=Sat
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
```

И тексты — собираем в один объект `UI`:

```ts
export const UI = {
  homeWelcome: (name?: string) =>
    `👋 Здравствуйте${name ? ', ' + name : ''}!\n` +
    `Я — бот «Премиум — уход за участком». Помогу заказать работы по дому и участку в Омске за пару минут.`,
  homeMenu: 'Что вас интересует?',

  // ... тексты воронки, см. выше
  orderConfirmTpl: (p: {
    service: string; area?: string; district?: string; when?: string;
    priceLow: number; priceHigh: number;
    discountPercent?: number; bonusRub?: number;
    finalLow?: number; finalHigh?: number;
  }) => {
    const lines: string[] = [];
    lines.push('✅ Проверьте, всё верно?\n');
    lines.push(`Услуга: <b>${p.service}</b>`);
    if (p.area)     lines.push(`Площадь/объём: ${p.area}`);
    if (p.district) lines.push(`Район: ${p.district}`);
    if (p.when)     lines.push(`Когда: ${p.when}`);
    lines.push('');
    lines.push(`Цена: ${p.priceLow}–${p.priceHigh} ₽ (точно скажет мастер на месте)`);
    if (p.discountPercent || p.bonusRub) {
      const parts: string[] = [];
      if (p.discountPercent) parts.push(`−${p.discountPercent} % (постоянный клиент)`);
      if (p.bonusRub)        parts.push(`−${p.bonusRub} ₽ (реферальный бонус)`);
      lines.push(`🎁 Ваша скидка: ${parts.join(' и ')}`);
      if (p.finalLow !== undefined && p.finalHigh !== undefined) {
        lines.push(`Итого: ${p.finalLow}–${p.finalHigh} ₽`);
      }
    }
    return lines.join('\n');
  },

  thanksCard: (p: { humanId: string; service: string; when?: string; district?: string }) =>
    `✅ Заявка <b>#${p.humanId}</b> принята\n\n` +
    `Услуга: ${p.service}\n` +
    (p.when ? `Когда: ${p.when}\n` : '') +
    (p.district ? `Адрес: ${p.district}\n` : '') +
    `\nМастер свяжется с вами в течение 30 минут.`,

  myOrdersHeader: '📋 Мои заказы',
  myOrdersEmpty:  'У вас пока нет заказов. Хотите оформить?',

  referralIntro: (p: { link: string; invited: number; balance: number }) =>
    `🎁 Пригласите друга — получите 500 ₽ скидки\n\n` +
    `Как это работает:\n` +
    `1) Отправьте другу вашу ссылку.\n` +
    `2) Он заказывает любую услугу через бота.\n` +
    `3) Когда мастер выполнит работу — вам и другу автоматически придёт по 500 ₽ скидки на следующий заказ.\n\n` +
    `Ваша ссылка:\n${p.link}\n\n` +
    `Друзей пригласили: <b>${p.invited}</b>\n` +
    `Доступно сейчас: <b>${p.balance} ₽</b>`,

  // ... остальное
} as const;
```

### 4.3. Новый модуль `lib/orders.ts`

Здесь — read-side и команды для «Мои заказы», «Повторить», «Реферал».

```ts
import { supabaseAdmin } from './supabase';

export type OrderRow = {
  id: string;
  human_id: string;
  service_kind: string;
  service_name: string;
  status: string;
  area_value: number | null;
  area_unit: string | null;
  district: string | null;
  desired_date_from: string | null;
  desired_date_to: string | null;
  scheduled_at: string | null;
  price_quoted: number | null;
  discount_percent: number;
  discount_rub: number;
  created_at: string;
};

export async function listMyOrders(contactId: string, limit = 5): Promise<OrderRow[]> {
  const { data, error } = await supabaseAdmin()
    .from('v_my_orders')           // создаём в миграции (см. ниже)
    .select('*')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as OrderRow[];
}

export async function getOrder(contactId: string, leadId: string) {
  const { data, error } = await supabaseAdmin()
    .from('v_my_orders').select('*')
    .eq('contact_id', contactId).eq('id', leadId).maybeSingle();
  if (error) throw error;
  return data as OrderRow | null;
}

export async function ensureReferralCode(contactId: string): Promise<string> {
  const { data, error } = await supabaseAdmin().rpc('ensure_referral_code', { p_contact_id: contactId });
  if (error) throw error;
  return data as string;
}

export async function getReferralStats(contactId: string) {
  const sb = supabaseAdmin();
  const [{ data: invited }, { data: balance }] = await Promise.all([
    sb.from('referrals').select('id, status', { count: 'exact', head: false }).eq('referrer_contact_id', contactId),
    sb.from('loyalty_balances').select('bonus_rub').eq('contact_id', contactId).maybeSingle(),
  ]);
  return {
    invited: invited?.length ?? 0,
    qualified: invited?.filter(r => r.status === 'qualified').length ?? 0,
    balance: (balance as { bonus_rub: number } | null)?.bonus_rub ?? 0,
  };
}

export async function repeatOrder(contactId: string, oldLeadId: string, when: { label?: string; custom?: string }) {
  const old = await getOrder(contactId, oldLeadId);
  if (!old) throw new Error('Lead not found');

  const { data: leadId, error } = await supabaseAdmin().rpc('create_lead', {
    p_contact_id: contactId,
    p_service_kind: old.service_kind,
    p_channel: 'telegram', // override снаружи если нужно
    p_description: null,
    p_area_value: old.area_value,
    p_area_unit: old.area_unit,
    p_district: old.district,
    p_address: null,
    p_metadata: { repeat_of: oldLeadId, when_label: when.label, when_custom: when.custom },
  });
  if (error) throw error;
  return leadId as string;
}

export async function applyDiscount(contactId: string, leadId: string, serviceKind: string) {
  const sb = supabaseAdmin();
  const { data, error } = await sb.rpc('compute_discount_for_contact', {
    p_contact_id: contactId, p_service_kind: serviceKind,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  const percent = (row?.percent ?? 0) as number;
  const bonusRub = (row?.rub_bonus ?? 0) as number;

  // фиксируем в leads
  await sb.from('leads').update({
    discount_percent: percent,
    discount_rub: bonusRub > 0 ? Math.min(bonusRub, 500) : 0,
  }).eq('id', leadId);

  // списываем бонус
  if (bonusRub > 0) {
    await sb.rpc('spend_bonus', {
      p_contact_id: contactId,
      p_amount: Math.min(bonusRub, 500),
      p_lead_id: leadId,
    });
  }
  return { percent, bonusRub: Math.min(bonusRub, 500) };
}
```

И вью `v_my_orders` (в миграции):

```sql
create or replace view public.v_my_orders as
select
  l.id,
  l.contact_id,
  encode(digest(l.id::text, 'sha1'), 'hex') as digest_id,   -- если нужен короткий
  'A-' || lpad((1000 + (extract(epoch from l.created_at)::bigint % 9000))::text, 4, '0') as human_id,
  l.service_kind,
  s.name as service_name,
  l.status::text,
  l.area_value, l.area_unit, l.district,
  l.desired_date_from, l.desired_date_to, l.scheduled_at,
  l.price_quoted, l.discount_percent, l.discount_rub,
  l.created_at
from public.leads l
join public.services s on s.id = l.service_id
where l.deleted_at is null;
```

> Пояснение по `human_id`: для UX («Заказ #A-1042») мы не показываем UUID, а
> делаем псевдо-короткий идентификатор. Можно заменить на отдельную колонку
> `human_id text generated always as ...` или `serial`.

### 4.4. Новые ветки в `api/telegram/webhook.ts` и `api/max/webhook.ts`

#### Структура `onCallback` после редизайна

Каждая кнопка имеет формат `<scope>:<action>[:<arg>]`. Парсим и роутим:

```ts
async function onCallback(cb: NonNullable<TgUpdate['callback_query']>) {
  const chatId = cb.message?.chat.id ?? cb.from.id;
  const data = cb.data ?? '';
  await answerCallbackQuery(cb.id);

  const ctx = await getCtx(cb.from); // upsert + identity + session

  const [scope, action, ...rest] = data.split(':');
  const arg = rest.join(':');

  switch (scope) {
    case 'svc':       return startOrder(ctx, action as ServiceKind, chatId);
    case 'area':      return setArea(ctx, action, arg, chatId);
    case 'dist':      return setDistrict(ctx, action, arg, chatId);
    case 'when':      return setWhen(ctx, action, arg, chatId);
    case 'confirm':   return action === 'ok' ? confirmOrder(ctx, chatId) : cancelOrder(ctx, chatId);
    case 'edit':      return editField(ctx, action, chatId);
    case 'lead':      return leadAction(ctx, action, arg, chatId);   // contact|cancel|repeat|edit_date
    case 'cb':        return toggleLandSubtask(ctx, action as 'land', arg, chatId);
    case 'nav':
      switch (action) {
        case 'home':     return showHome(ctx, chatId);
        case 'orders':   return showMyOrders(ctx, chatId);
        case 'referral': return showReferral(ctx, chatId);
        case 'help':     return showHelp(ctx, chatId);
        case 'operator': return showOperator(ctx, chatId);
      }
  }
}
```

#### Пример: «Мои заказы»

```ts
async function showMyOrders(ctx: Ctx, chatId: number) {
  const orders = await listMyOrders(ctx.contactId, 5);
  if (orders.length === 0) {
    await sendMessage(chatId, UI.myOrdersEmpty, { reply_markup: mainMenuKeyboard() });
    return;
  }
  await sendMessage(chatId, UI.myOrdersHeader);
  for (const o of orders) {
    const statusUI = mapStatusToUi(o.status);
    const text =
      `${statusUI.icon} <b>Заказ #${o.human_id}</b> — ${o.service_name}\n` +
      (o.desired_date_from ? `Дата: ${formatDateRange(o.desired_date_from, o.desired_date_to)}\n` : '') +
      (o.district ? `Адрес: ${o.district}` : '') +
      (o.area_value ? `, ${o.area_value} ${o.area_unit}\n` : '\n') +
      `Статус: ${statusUI.label}` +
      (o.price_quoted ? `\nЦена: ~${o.price_quoted} ₽` : '');

    const buttons = [
      [{ text: '📞 Связаться',     callback_data: `lead:contact:${o.id}` }],
      [{ text: '🔁 Повторить такой же', callback_data: `lead:repeat:${o.id}` }],
    ];
    if (canEditDate(o.status)) buttons.unshift([{ text: '✏️ Изменить дату', callback_data: `lead:edit_date:${o.id}` }]);
    if (canCancel(o.status))   buttons.push([{ text: '❌ Отменить', callback_data: `lead:cancel:${o.id}` }]);

    await sendMessage(chatId, text, { reply_markup: inlineKeyboard(buttons) });
  }
  await sendMessage(chatId, ' ', { reply_markup: inlineKeyboard([[{ text: '🏠 В меню', callback_data: 'nav:home' }]]) });
}
```

#### Пример: «Реферальная программа»

```ts
async function showReferral(ctx: Ctx, chatId: number) {
  const code = await ensureReferralCode(ctx.contactId);
  const stats = await getReferralStats(ctx.contactId);
  const link = `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=ref_${code}`;

  await sendMessage(chatId, UI.referralIntro({
    link,
    invited: stats.invited,
    balance: stats.balance,
  }), {
    reply_markup: inlineKeyboard([
      [{ text: '📤 Поделиться ссылкой', url:
        `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Премиум — уход за участком в Омске. По ссылке +500 ₽ нам обоим')}` }],
      [{ text: '📋 Мои рефералы', callback_data: 'nav:referral_list' }],
      [{ text: '🏠 В меню', callback_data: 'nav:home' }],
    ]),
  });
}
```

#### Пример: «Повторить заказ»

```ts
async function leadAction(ctx: Ctx, action: string, leadId: string, chatId: number) {
  if (action === 'repeat') {
    const old = await getOrder(ctx.contactId, leadId);
    if (!old) {
      await sendMessage(chatId, 'Заказ не найден.', { reply_markup: backToHome() });
      return;
    }
    await updateSession(ctx.identityId, {
      funnel: 'repeat', step: 'when',
      state: { activeLeadId: leadId, serviceKind: old.service_kind },
    });
    await sendMessage(chatId,
      `🔁 <b>Повторяем заказ</b>\n` +
      `Услуга: ${SERVICE_LABEL[old.service_kind as ServiceKind]}\n` +
      (old.district ? `Адрес: ${old.district}\n` : '') +
      (old.area_value ? `Площадь: ${old.area_value} ${old.area_unit}\n` : '') +
      `\nКогда удобно?`,
    {
      reply_markup: whenKeyboard(),
    });
    return;
  }
  if (action === 'cancel') return cancelLead(ctx, leadId, chatId);
  if (action === 'edit_date') return startEditDate(ctx, leadId, chatId);
  if (action === 'contact')   return showOperator(ctx, chatId, leadId);
}
```

При выборе даты в режиме `funnel='repeat'`:

```ts
// в setWhen()
if (ctx.session.funnel === 'repeat') {
  const oldId = ctx.session.state.activeLeadId as string;
  const newLeadId = await repeatOrder(ctx.contactId, oldId, { label: action, custom: arg });
  await applyDiscount(ctx.contactId, newLeadId, ctx.session.state.serviceKind as ServiceKind);
  await updateSession(ctx.identityId, { funnel: 'main', step: 'service', state: {} });
  await sendMessage(chatId, UI.thanksRepeat({ ... }), { reply_markup: postOrderKeyboard() });
  notifyN8n(env.N8N_WEBHOOK_URL, { type: 'lead.created', leadId: newLeadId, contactId: ctx.contactId, serviceKind, channel: 'telegram' });
  return;
}
```

#### Обработка `/start ref_<code>` в `onMessage`

```ts
// в onMessage(), сразу после upsertContactByIdentity
if (text.startsWith('/start ref_')) {
  const code = text.slice('/start ref_'.length).trim();
  if (code) {
    const refId = await supabaseAdmin().rpc('record_referral_visit', {
      p_invitee_contact_id: contact_id, p_code: code,
    });
    if (refId.data) {
      await sendMessage(chatId, UI.referralActivated({ referrerName: 'друг' }), {
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }
  }
  // если код невалиден — показать обычный home
}
```

### 4.5. Что нужно добавить в `lib/telegram.ts`

```ts
export function whenKeyboard() {
  return inlineKeyboard([
    [{ text: 'Сегодня', callback_data: 'when:today' }, { text: 'Завтра', callback_data: 'when:tomorrow' }],
    [{ text: 'Эти выходные', callback_data: 'when:weekend' }, { text: 'На этой неделе', callback_data: 'when:thisweek' }],
    [{ text: '✏️ Другая дата', callback_data: 'when:custom' }],
    [{ text: '◀️ Назад', callback_data: 'back' }],
  ]);
}

export function districtKeyboard() {
  return inlineKeyboard([
    [{ text: 'Чкаловский', callback_data: 'dist:chkalovskiy' }, { text: 'Кировский', callback_data: 'dist:kirovskiy' }],
    [{ text: 'Ленинский', callback_data: 'dist:leninskiy' }, { text: 'Октябрьский', callback_data: 'dist:oktyabrskiy' }],
    [{ text: 'Советский', callback_data: 'dist:sovetskiy' }, { text: '✏️ Другой', callback_data: 'dist:other' }],
    [{ text: '◀️ Назад', callback_data: 'back' }],
  ]);
}

export function postOrderKeyboard() {
  return inlineKeyboard([
    [{ text: '📋 Мои заказы', callback_data: 'nav:orders' }],
    [{ text: '🎁 Пригласить друга и получить скидку', callback_data: 'nav:referral' }],
    [{ text: '🏠 В меню', callback_data: 'nav:home' }],
  ]);
}

export function mainMenuKeyboard() {
  return inlineKeyboard([
    [{ text: '🌱 Покос', callback_data: 'svc:lawn_mowing' }, { text: '🌿 Скарификация', callback_data: 'svc:scarification' }],
    [{ text: '🪓 Расчистка', callback_data: 'svc:land_clearing' }, { text: '🏊 Бассейн', callback_data: 'svc:pool_cleaning' }],
    [{ text: '📋 Мои заказы', callback_data: 'nav:orders' }, { text: '🎁 Пригласить друга', callback_data: 'nav:referral' }],
    [{ text: '❔ Помощь', callback_data: 'nav:help' }, { text: '☎️ Оператор', callback_data: 'nav:operator' }],
  ]);
}
```

То же — в `lib/max.ts`, только без эмодзи в шапке кнопок и с типом `'callback'` payload.

### 4.6. n8n: новые воркфлоу

#### 4.6.1. `05-referral-loyalty.json`

Триггер — событие `lead.status_changed → done`:

```
[Webhook /lead-events]
       │
       ▼
[IF body.type == 'lead.status_changed' AND body.to == 'done']
       │
       ▼
[Postgres: select * from leads where id = ...]
       │
       ▼
[Postgres: select qualify_referral(invitee_contact_id := lead.contact_id, lead_id := lead.id, bonus_rub := 500)]
       │
       ▼
[Postgres: select count(*) from referrals where referrer_contact_id = ... and status='qualified']
       │ (если первое квалифицирование)
       ▼
[Telegram: уведомить рефералов] 
[Postgres: insert into events ('referral.qualified', …)]
```

Дополнительно: ветка «триггер первой повторной заявки» — если у клиента
`done`-заказ покоса и через 14 дней нет нового лида, n8n cron шлёт
`firstRepeatHint` (см. шаблон в 3.3). Это просто расширение существующего
`02-recurring-mowing.json`, без отдельного workflow.

#### 4.6.2. Отчёт владельцу: «топ-рефералы»

Отдельный cron раз в неделю (понедельник 09:00):

```
[Cron Mon 09:00]
       │
       ▼
[Postgres:
  select c.full_name, count(r.*) filter (where r.status='qualified') as qualified,
         count(r.*) as total
    from public.contacts c
    join public.referrals r on r.referrer_contact_id = c.id
   where r.created_at > now() - interval '7 days'
   group by c.id
   order by qualified desc nulls last
   limit 10]
       │
       ▼
[Set: формат таблички]
       │
       ▼
[Telegram: send to OWNER_CHAT_ID]
```

---

## Шаг 5. Визуальная «приятность» и интуитивность

### 5.1. Структура любого сообщения бота

Все сообщения бота строим по схеме:

```
[1] Иконка / эмодзи статуса (1 шт)  ← опциональная, только когда несёт смысл
[2] Заголовок (жирный)              ← одна строка
[3] Пустая строка
[4] Список параметров (если есть)   ← Ключ: значение, по одному в строке
[5] Пустая строка
[6] Призыв к действию или вопрос    ← одна-две строки
[7] Кнопки                          ← inline_keyboard
```

Пример (карточка заказа):

```
🟢 Заказ #A-1042 — Покос газона     ← [1]+[2]
                                     ← [3]
Дата: эти выходные                   ← [4]
Адрес: Чкаловский, 5–10 соток
Статус: согласован
Цена: ~3 200 ₽
                                     ← [5]
Что сделать?                         ← [6]
[ ✏️ Изменить дату ]                ← [7]
[ 📞 Связаться ]
[ 🔁 Повторить такой же ]
```

### 5.2. Эмодзи: когда уместно

| Где                             | Telegram          | MAX                 |
|---------------------------------|-------------------|---------------------|
| Заголовок раздела (📋, 🎁)      | ✅ нормально      | ⚠️ только если функциональное |
| Иконка статуса (🟢🟡🔵✅)       | ✅                 | ✅                 |
| В каждой строке параметров     | ❌ не надо        | ❌                 |
| В тексте кнопок                | ✅ небольшие       | ⚠️ функциональные (✓, ✖) |
| В callback-ответах оператора    | ❌                 | ❌                 |

Правило: одно сообщение — не более **одного декоративного** эмодзи в заголовке. Все остальные эмодзи только статусные.

### 5.3. Эталонные сообщения

#### Карточка активного заказа (Telegram)

```html
🟢 <b>Заказ #A-1042 — Покос газона</b>

Дата: 11–12 мая (эти выходные)
Адрес: Чкаловский р-н, 5–10 соток
Статус: согласован, мастер приедет в субботу

Цена: ~3 200 ₽
🎁 Со скидкой постоянного клиента: ~2 880 ₽

Что сделать?
```

```
[ ✏️ Изменить дату ] [ 📞 Связаться ]
[ ❌ Отменить ]
[ 🔁 Повторить такой же ]
```

#### Программа лояльности (Telegram)

```html
🎁 <b>Пригласите друга — получите 500 ₽ скидки</b>

Как это работает:
1. Отправьте другу свою ссылку.
2. Он заказывает любую услугу через бота.
3. Когда мастер выполнит работу — вам и другу автоматически придёт по 500 ₽ скидки.

Ваша ссылка:
<code>https://t.me/premium_omsk_bot?start=ref_AB1234</code>

Друзей пригласили: <b>2</b>
Доступно сейчас: <b>500 ₽</b>
```

```
[ 📤 Поделиться ссылкой ]
[ 📋 Мои рефералы ]
[ 🏠 В меню ]
```

#### Быстрый повторный заказ — 1 клик

Сообщение 1 (после нажатия `🔁 Повторить такой же`):

```
🔁 <b>Повторяем заказ</b>
Услуга: Покос газона
Адрес: Чкаловский, 5–10 соток

Когда удобно?
```

```
[ Сегодня ] [ Завтра ]
[ Эти выходные ] [ На неделе ]
[ ✏️ Другая дата ]
```

Сообщение 2 (после выбора, без вопросов про телефон/район — всё уже есть):

```
✅ <b>Готово!</b>

Заказ #A-1057 принят
Услуга: Покос газона (повтор)
Когда: эти выходные
Адрес: Чкаловский, 5–10 соток

🎁 Скидка постоянного клиента: −10 % (применена)
Цена со скидкой: ~2 880 ₽

Мастер свяжется в течение 30 минут.
```

```
[ 📋 Мои заказы ]
[ 🏠 В меню ]
```

---

## Чек-лист перед выкаткой UX-редизайна

- [ ] Применена миграция `20260507000004_loyalty_referrals.sql`.
- [ ] В `services.season_months` обновлены сезоны под Омск (уже сделано в seed).
- [ ] В `lib/funnels.ts` добавлены новые экраны и `Screen` тип.
- [ ] В `lib/orders.ts` появились функции `listMyOrders`, `repeatOrder`, `ensureReferralCode`, `getReferralStats`, `applyDiscount`.
- [ ] `mainMenuKeyboard()` обновлён в обоих ботах.
- [ ] Обработчики разбиты по `scope:action:arg`-роутингу.
- [ ] Поддерживается `/start ref_<code>`.
- [ ] n8n-воркфлоу `05-referral-loyalty.json` импортирован и активен.
- [ ] Тестовый прогон: сделать новый заказ → перевести в `done` → проверить, что у `referrer` и `invitee` появилось +500 ₽ в `loyalty_balances`.
- [ ] Тестовый прогон: «🔁 Повторить» с уже выполненным заказом → новая заявка с `repeat_of` и `discount_percent=10`.
