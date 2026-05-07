# 05. Воронки и триггеры (Telegram + MAX)

## 5.1. Общий каркас воронки

Один и тот же пайплайн для всех 4 услуг — отличаются только тексты и парсеры:

```
service → area → district → description → photos → date → phone → done
```

Состояние хранится в `bot_sessions.state` (jsonb). На каждом шаге:

- Vercel-функция читает текущий шаг и `state`.
- Применяет ввод пользователя.
- Сохраняет новый `step` и патч `state`.
- Шлёт следующий вопрос.

### Что сохраняется в `leads` после `done`

| Поле           | Из state                                       |
|----------------|------------------------------------------------|
| `service_kind` | `state.serviceKind`                            |
| `area_value`   | `state.area`                                   |
| `area_unit`    | `state.areaUnit`                               |
| `district`     | `state.district`                               |
| `description`  | `state.description`                            |
| `metadata`     | `{ desiredDate, mediaIds, phone }`             |
| `channel`      | `'telegram'` / `'max'`                         |
| `status`       | `'new'`                                        |

Создание идёт через RPC `create_lead`, которая дополнительно пишет событие
`lead.created` в `events`.

## 5.2. Тексты по услугам

### Покос газона
- Старт: `Отлично, оформляем «Покос газона». Ориентир по цене:
  ≈ 250–600 ₽ за сотку (зависит от высоты травы и рельефа). Подскажите,
  пожалуйста, какая площадь участка (в сотках или м²)?`
- Тег: при `area > 10 соток` → автотег `big_lawn`.
- Сезон: 5–9 (см. `services.season_months`).

### Скарификация / аэрация
- Старт: тот же шаблон, цена `≈ 400–800 ₽ за сотку` / `≈ 350–700 ₽`.
- Сезон: 4, 5, 9, 10. Вне сезона — отвечаем что предзапись на весну/осень.

### Расчистка участка (включает спил, корчевание, уборку мусора)
- Уточняем подзадачу: «расчистка», «спил деревьев», «корчевание пней», «вывоз мусора».
- Соответствующий `service_kind`: `land_clearing` | `tree_cutting` |
  `stump_removal` | `debris_removal`.
- Цена: `≈ 600–1500 ₽ за сотку` / `≈ 1500–15000 ₽ за дерево` /
  `≈ 1500–8000 ₽ за пень` / `≈ 1500–4000 ₽ за час`.
- Тег: фото обязательны для оценки (бот просит, но допускает «Пропустить»).

### Чистка / сборка бассейнов
- Уточняем: чистка существующего vs сборка/запуск нового.
- `service_kind`: `pool_cleaning` | `pool_assembly`.
- Цена: `≈ 200–400 ₽ за м³` / `≈ 3000–12000 ₽ за бассейн`.
- Авто-тег `pool_owner` контакту.

## 5.3. Теги и статусы

Базовые теги (см. `seed.sql`):

| Code              | Когда вешается                                      |
|-------------------|-----------------------------------------------------|
| `vip`             | руками (CRM-операция)                               |
| `big_lawn`        | автоматически при `area > 10` соток                |
| `pool_owner`      | автоматически при заявке `pool_cleaning`/`assembly` |
| `repeat`          | при `count(leads) > 1` у контакта                   |
| `cold`            | n8n-cron: нет активности 30+ дней                   |
| `district_left/right` | по району (Левый/Правый берег Иртыша)           |

Статусы лида (`lead_status`):

```
new → qualifying → qualified → quoted → scheduled → in_progress → done
                                                                  ↘ lost / archived
```

- `new` ставится автоматически при создании.
- `qualifying` — после первого ответа оператора (n8n или вручную).
- `quoted` — после отправки цены.
- `scheduled` — когда `scheduled_at IS NOT NULL`.
- `done` — при заполнении `completed_at` и `price_final`.

Изменения статусов идут через RPC `set_lead_status(p_lead_id, p_status)` —
она пишет событие `lead.status_changed`.

## 5.4. Триггерные сценарии

### 5.4.1. «Новый лид»

```
Voucher: Vercel-handler → notifyN8n('lead.created')
n8n (01-lead-events):
  • Webhook
  • IF secret OK
  • Postgres: select … (имя, телефон, район, описание, услуга)
  • Set ownerText
  • Telegram → owner chat
  • Postgres: insert into events ('owner.notified', …)
```

Клиенту подтверждение шлёт сама Vercel-функция (`TEXT.thanks(kind)`).

### 5.4.2. «Повторный покос»

Сегмент SQL — `public.segment_for_recurring_lawn_mowing(p_days_since,
p_campaign_code, p_channel)`. Условия:

- последний `lead.completed_at` где `service_kind='lawn_mowing'` старше `p_days_since` дней;
- `unsubscribed = false`, `consent_marketing = true`;
- сейчас сезон (месяц 5..9);
- ещё не получали этой кампании в последние 20 дней.

n8n (`02-recurring-mowing.json`):

1. Cron Mon/Wed/Fri 09:00.
2. Postgres → выборка контактов с identity.
3. SplitInBatches 20.
4. Wait 1s.
5. IF (channel == telegram?) → ветка для Telegram / ветка для MAX.
6. Postgres → `insert into campaign_recipients … on conflict do update`.

Текст для Telegram (HTML):
```
🌱 Здравствуйте, {имя}!
Ваш газон в {район} уже отрос — пора снова на покос.
Записать вас на ближайшие дни? Ответьте «да» или нажмите /start.
```

Текст для MAX:
```
🌱 Здравствуйте, {имя}! Пора снова на покос — записать вас?
```

### 5.4.3. «Сезонная скарификация / аэрация»

- 1 апреля и 1 сентября в 10:00 — `cron 0 10 1 4,9 *`.
- Сегмент: `segment_for_seasonal_service('scarification', 'seasonal_scarification')`.
- Текст:
  ```
  🌿 Привет, {имя}!
  Стартовал сезон скарификации и аэрации газона.
  Хотите освежить свой? Напишите — рассчитаем стоимость.
  ```

### 5.4.4. «Сезонный запуск/чистка бассейнов»

- 1 и 15 мая (старт сезона) — `cron 0 10 1,15 5 *` — рассылка по
  `pool_owner`.
- 15 сентября (консервация) — `cron 0 11 15 9 *` — отдельная кампания
  `seasonal_pool_close` (создать в `campaigns`).
- Тексты см. `seed.sql` → `seasonal_pool_open`.

### 5.4.5. «Холодный клиент»

- Cron раз в сутки.
- Сегмент: контакты с `last_activity_at < now() - interval '30 days'`,
  `unsubscribed = false`.
- Действие: автоматически вешать тег `cold` (insert в `contact_tags`),
  опционально — мягкое сообщение «давно не виделись, нужны ли работы?»
  Не чаще, чем раз в 60 дней.

## 5.5. Логика в SQL: примеры выборок

```sql
-- Все активные лиды по покосу, ещё не оплачены
select * from public.v_active_leads
 where service_kind = 'lawn_mowing'
   and status in ('quoted', 'scheduled', 'in_progress');

-- Сегмент для скарификации (сезон + были покосы → скорее всего нужен газон-уход)
select c.id, c.full_name, ci.channel, ci.external_id
  from public.contacts c
  join public.contact_identities ci on ci.contact_id = c.id
 where c.unsubscribed = false
   and c.consent_marketing = true
   and ci.is_blocked = false
   and exists (
     select 1 from public.leads l
      where l.contact_id = c.id and l.service_kind = 'lawn_mowing'
   );
```

## 5.6. Как помечать лид тегом

```sql
-- автотег big_lawn после создания заявки
insert into public.lead_tags (lead_id, tag_id)
select :lead_id, t.id from public.tags t where t.code = 'big_lawn'
 on conflict do nothing;

-- автотег pool_owner у контакта
insert into public.contact_tags (contact_id, tag_id)
select :contact_id, t.id from public.tags t where t.code = 'pool_owner'
 on conflict do nothing;
```

Эти insert'ы можно делать прямо в RPC `create_lead` (расширение в следующей
миграции) или внутри n8n-воркфлоу `01-lead-events.json` (отдельной нодой
Postgres).
