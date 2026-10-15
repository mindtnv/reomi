# Proposal

## Why

Продукт для пользователей уже называется Reomi (`app.reomi.ru`, `api.reomi.ru`, заголовок, манифест, i18n), но репозиторий, пакеты, образы, Coolify, MCP и часть писем всё ещё представляют NeuroNexus. Issue #41 и решение владельца фиксируют полное переименование и отказ от алиаса `api.neuronexus.mihailantonov.pro`.

## What Changes

- Довести пользовательские остатки бренда до Reomi: тема письма сброса пароля, текст MCP, realm, User-Agent чтения страниц, имена скачиваемых файлов. Заголовок, манифест и i18n уже Reomi и не переписываются заново.
- **BREAKING** для клиентов старого API: `https://api.neuronexus.mihailantonov.pro` перестаёт быть совместимым алиасом. Канон остаётся `https://api.reomi.ru` и `https://app.reomi.ru`. Редирект веб-хоста `neuronexus.mihailantonov.pro` → `app.reomi.ru` сохраняется.
- Перенести сохранённые ключи браузера `nn:*` на `reomi:*` чтением старого значения, без удаления старых ключей в первом релизе. Сессионная кука Better Auth, `BETTER_AUTH_SECRET`, префикс PAT `nn_pat_` и серверные данные не меняются — действующий вход на `api.reomi.ru` не сбрасывается.
- MCP представляет себя как `reomi`, ресурсы доступны как `reomi://…`, а `neuronexus://…` и переменные `NEURONEXUS_MCP_*` остаются алиасами. Имена инструментов не меняются.
- Переименовать внутренние пакеты `@neuronexus/*` в `@reomi/*` отдельным PR. Имена образов GHCR перевести на `reomi-api` / `reomi-web` через окно двойной публикации.
- Репозиторий GitHub владелец переименовывает в `reomi` вручную после окна двойной публикации образов. Приложения Coolify не пересоздаются: владелец сам снимает API-алиас, переключает репозиторий образа и при необходимости имя приложения и `EMAIL_FROM`.

## Capabilities

### New Capabilities

- `product-identity`: пользовательское имя Reomi, непрерывность сессии и локальных предпочтений при смене ключей браузера.

### Modified Capabilities

- `production-domain-routing`: бывший API-хост больше не является совместимым алиасом; редирект бывшего веб-хоста сохраняется.
- `knowledge-mcp`: каноническая идентичность MCP — Reomi, прежние URI и переменные клиента остаются рабочими алиасами.
- `personal-access-tokens`: переименование не отзывает уже выданные секреты и не меняет префикс `nn_pat_`.

## Impact

Затронуты веб и API (тексты, MCP, миграция localStorage/sessionStorage, в том числе скрипт темы до первой отрисовки), пакеты workspace, `.github/workflows/deploy.yml`, документация (`README.md`, `docs/mcp.md`, `docs/reomi-domain-migration.md`, `CLAUDE.md` / `AGENTS.md`) и ручные шаги GitHub, Coolify и DNS.

Не меняются и не являются целью этого change: имя и роль прод-БД, том Postgres, бакет `s3.1dedic.ru/neuronexus`, секрет и префикс куки Better Auth, префикс PAT, CSS-классы `.nn-*`, компоненты `NN*`, внутрипроцессные события `nn:*`, маркер истории `nnNavigation`, архив `openspec/changes/archive/`, purpose чужих capability без смены поведения, лендинг апекса `reomi.ru`. Схема БД не меняется.
