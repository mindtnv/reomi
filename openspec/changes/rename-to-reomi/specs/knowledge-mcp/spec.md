## ADDED Requirements

### Requirement: MCP identity during the product rename
Каноническое имя MCP-сервера SHALL быть `reomi`. Объявленные ресурсы SHALL быть доступны как `reomi://guide` и `reomi://connection`. Прежние URI `neuronexus://guide` и `neuronexus://connection` MUST разрешаться в то же содержимое и ту же область доступа. Имена инструментов MUST NOT меняться. Клиентские переменные `REOMI_MCP_URL`, `REOMI_MCP_TOKEN` и `REOMI_MCP_TOKEN_FILE` SHALL приниматься; прежние `NEURONEXUS_MCP_*` MUST оставаться рабочими алиасами тех же значений. Переименование MUST NOT ослаблять проверку Origin, изоляцию пользователей и запрет мутаций для токена только на чтение.

#### Scenario: New resource identity
- **WHEN** клиент с действительным персональным токеном читает `reomi://guide` или `reomi://connection`
- **THEN** он получает прежнее описание правил и метаданные только своего подключения

#### Scenario: Legacy resource alias
- **WHEN** клиент читает `neuronexus://guide` или `neuronexus://connection` тем же токеном
- **THEN** ответ совпадает с каноническим URI той же пары
- **AND** чужое содержимое не возвращается

#### Scenario: Legacy client environment
- **WHEN** локальный мост запущен только с прежними переменными `NEURONEXUS_MCP_*`
- **THEN** он подключается к тому же endpoint и с тем же токеном, что и при `REOMI_MCP_*`

#### Scenario: Read-only token and untrusted origin
- **WHEN** токен только на чтение вызывает мутацию по прежнему или новому имени либо запрос приходит с недоверенного Origin
- **THEN** мутация не выполняется, а недоверенный Origin отклоняется
