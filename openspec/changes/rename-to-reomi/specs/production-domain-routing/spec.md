## MODIFIED Requirements

### Requirement: Legacy-address compatibility
Прежний веб-хост SHALL перенаправлять на фиксированный канонический origin приложения, сохраняя путь и query. Прежний API-хост SHALL NOT оставаться совместимым алиасом. Клиенты MUST использовать `https://api.reomi.ru`. Снятие алиаса MUST NOT изменять учётные записи, персональные токены и данные на каноническом API.

#### Scenario: Existing deep link
- **WHEN** пользователь открывает `https://neuronexus.mihailantonov.pro/cards?focus=example`
- **THEN** ответ перенаправляет на `https://app.reomi.ru/cards?focus=example`
- **AND** запросы к каноническому хосту и локальной разработке этим правилом не перенаправляются

#### Scenario: Existing integration
- **WHEN** интеграция вызывает прежний API-хост с действующим персональным токеном после снятия алиаса
- **THEN** этот хост больше не обязан достигать API
- **AND** тот же токен сохраняет прежнюю область доступа на `https://api.reomi.ru`
