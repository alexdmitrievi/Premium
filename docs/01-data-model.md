# 01. Модель данных и Supabase

## 1.1. Сущности

### Контакт (`contacts`)
Один человек = одна строка. У одного контакта может быть несколько каналов
(`contact_identities`), несколько заявок (`leads`) и переписка
(`messages`). Поля:

- `full_name`, `phone` (`phone_normalized` — generated, для поиска),
  `email`, `city`, `district`, `address`, `geo_lat/lon`;
- `preferred_channel` — куда писать первым делом;
- `language`;
- `consent_marketing` + `consent_marketing_at` — явное согласие на рассылку;
- `unsubscribed` + `unsubscribed_at` — принудительный «не слать»;
- `notes`;
- `source_id` → `traffic_sources` (откуда пришёл);
- `created_at` / `updated_at` / `deleted_at` (soft delete).

### Лид/Заявка (`leads`)
Одна услуга — одна заявка. Повторный покос того же клиента — **новая** запись
(история сохраняется). Поля:

- `contact_id` (FK), `service_id` + `service_kind` (ENUM денормализованно для
  быстрых фильтров);
- `source_id`, `channel`, `status` (`lead_status` ENUM);
- `area_value` + `area_unit` (`сотка | м2 | час | шт`), `description`;
- `city/district/address`;
- `desired_date_from/to`, `scheduled_at`, `completed_at`;
- `price_quoted`, `price_final`, `currency`;
- `metadata jsonb` — всё, что не помещается в основные поля
  (id фото, `desiredDate` строкой, нестандартные параметры);
- `last_activity_at` (обновляется триггером по сообщениям);
- `created_at` / `updated_at` / `deleted_at`.

### Услуга (`services`)
Справочник. Тип — `service_kind` ENUM:
`lawn_mowing`, `scarification`, `aeration`, `land_clearing`, `tree_cutting`,
`stump_removal`, `debris_removal`, `pool_cleaning`, `pool_assembly`.

Поля: `name`, `short_name`, `description`, `unit`, `price_min`, `price_max`,
`season_months int[]` (массив 1..12 для триггерных рассылок),
`is_active`, `sort_order`.

### Источник трафика (`traffic_sources`)
`code` (machine-readable: `avito`, `telegram_bot`, `max_bot`, `referral`,
`telegram_channel`...), `name`, `channel`, `description`. Контакт и лид
ссылаются на источник, но `code` свободно меняется без миграций.

### Дополнительные

- `contact_identities` — связки (channel, external_id) для каждого мессенджера.
  Уникальный индекс `(channel, external_id)`. Нужен, чтобы один контакт
  мог иметь и Telegram, и MAX, и не было дублей.
- `tags` + `contact_tags` + `lead_tags` — теги.
- `lead_media` — фото/видео объектов.
- `messages` — архив переписки (вход/выход).
- `bot_sessions` — машина состояний воронки (один пользователь → одна сессия).
- `campaigns` + `campaign_recipients` — массовые рассылки.
- `events` — бизнес-события (`lead.created`, `lead.status_changed`,
  `contact.unsubscribed`, `owner.notified` и т.п.).
- `webhook_inbox` — лог входящих апдейтов с уникальным `(channel, external_id)`
  для идемпотентности.
- `app_logs` — структурированные логи приложения.

## 1.2. Почему теги через таблицу, а не jsonb

Теги хранятся как `tags` + `contact_tags` / `lead_tags`. Альтернатива — массив
строк или `jsonb` в самом контакте. Я выбрал отдельную таблицу:

- **Сегменты для рассылок**: SQL вида `where exists (select 1 from contact_tags
  where contact_id=c.id and tag_id=...)` индексируется лучше, чем `where tags @>
  '["pool_owner"]'::jsonb` (особенно когда тегов много и они часто меняются).
- **Целостность**: переименовали тег в `tags.name` — он сразу обновился
  везде; в jsonb пришлось бы догонять записи.
- **UI**: справочник с цветами (`tags.color`) и описанием — естественно как таблица.
- **Стоимость**: оверхед на m2m небольшой, индексов на (`tag_id`) и (`contact_id, tag_id`)
  достаточно.

Если завтра захочется фасет «динамические свойства» (например, «у клиента
есть собака, не косить ниже 5 см») — это уже `jsonb metadata` в `contacts`,
а не теги.

## 1.3. Индексы

Главные:

- `idx_contacts_phone (phone_normalized)` — поиск по телефону.
- `idx_contacts_full_name_trgm (full_name gin_trgm_ops)` — fuzzy-поиск.
- `idx_contacts_unsubscribed (unsubscribed) where unsubscribed = false` —
  частичный, ускоряет рассылочные выборки.
- `idx_leads_service_kind`, `idx_leads_status`, `idx_leads_last_activity desc`,
  `idx_leads_completed_at` — для отчётов и сегментов.
- Уникальный `uq_messages_external (channel, direction, external_id)` —
  идемпотентная запись сообщений.
- Уникальный `(channel, external_id)` в `webhook_inbox` — идемпотентность апдейтов.

## 1.4. Миграции и применение

### Структура

```
supabase/
├── config.toml
├── migrations/
│   ├── 20260507000001_init_schema.sql       — таблицы, ENUM, индексы, триггеры
│   ├── 20260507000002_rpc_and_views.sql     — RPC и views (upsert_contact_by_identity, create_lead, segment_*, v_active_leads)
│   └── 20260507000003_rls.sql               — Row Level Security (anon read services)
└── seed/
    └── seed.sql                             — справочники (services, traffic_sources, tags, campaigns)
```

### Локально (Supabase CLI)

```bash
npm i -g supabase
supabase login
export SUPABASE_PROJECT_REF=your-ref
export SUPABASE_DB_PASSWORD=your-db-password
supabase link --project-ref "$SUPABASE_PROJECT_REF"
supabase db push                            # накатить все миграции
psql "$SUPABASE_DB_URL" -f supabase/seed/seed.sql   # применить seed (опционально)
```

### Через GitHub Actions

В репозитории есть `.github/workflows/supabase-migrate.yml`. На `push` в
`main`, если изменились файлы в `supabase/migrations/**` или `supabase/seed/**`,
workflow:

1. поставит Supabase CLI;
2. сделает `supabase link --project-ref $SUPABASE_PROJECT_REF`;
3. выполнит `supabase db push --include-all`;
4. опционально (через `workflow_dispatch` с `include_seed=true`) применит seed.

Секреты, которые надо положить в Settings → Environments → production:

- `SUPABASE_ACCESS_TOKEN` (`supabase login → Personal access token`).
- `SUPABASE_PROJECT_REF`.
- `SUPABASE_DB_PASSWORD`.

### Создание новой миграции

```bash
# изменили схему локально через Studio или SQL — сгенерили diff
supabase db diff -f add_some_field
# создаст файл supabase/migrations/<timestamp>_add_some_field.sql
git add supabase/migrations
git commit -m "db: add some field"
git push   # дальше CI применит на проде
```
