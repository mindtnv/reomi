# Migration-Faithful CI Specification

## Purpose

Ensure automated verification proves that the committed database migration chain can build the schema required by the application.

## Requirements

### Requirement: CI tests the migrated schema without schema push
Every migration-gated CI workflow SHALL apply the committed migration chain to its test database and SHALL run the full test suite without invoking a schema-push command afterward.

#### Scenario: Pull-request verification
- **WHEN** the pull-request workflow reaches its database test gate
- **THEN** it applies committed migrations and executes the full suite through a command that has no `db:push` lifecycle hook

#### Scenario: Main-branch verification
- **WHEN** the main-branch deployment workflow reaches its database test gate
- **THEN** it applies committed migrations and executes the same migration-faithful test command before deployment can proceed

### Requirement: Local tests remain convenient
The default local full-test command SHALL prepare the disposable test database by applying the committed migration chain before executing tests. That command SHALL NOT reconcile the test database with schema push.

#### Scenario: Developer runs the default test command
- **WHEN** a developer runs the documented local full-test command
- **THEN** committed migrations are applied to the test database before the test runner starts

### Requirement: Schema push does not connect to the application database
A schema-push command SHALL open only the disposable test database identified by `TEST_DATABASE_URL`. It SHALL NOT connect using `DATABASE_URL`.

#### Scenario: Schema push is invoked
- **WHEN** a schema-push command runs
- **THEN** its connection URL is `TEST_DATABASE_URL` and is not `DATABASE_URL`

### Requirement: OpenSpec artifacts are validated in CI
Pull-request and main-branch CI SHALL reject invalid OpenSpec changes or specifications.

#### Scenario: Invalid change artifact is committed
- **WHEN** an OpenSpec artifact fails repository-wide validation
- **THEN** the CI test gate fails before deployment
