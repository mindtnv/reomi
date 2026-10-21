## Purpose

Keep the serving release available when image preparation fails, and recover promptly from failed replacements without racing application migrations.

## ADDED Requirements

### Requirement: Prepare the release before draining
Deployment SHALL verify both immutable application images are available on the target server before stopping the current API. Preparation SHALL NOT run application entrypoints, migrations, or access application credentials.

#### Scenario: Registry is unavailable
- **WHEN** preparation exhausts bounded retries
- **THEN** deployment fails while both current applications retain their tags and remain running

#### Scenario: Images are ready
- **WHEN** both images have successfully started harmless preparation containers on the same target server
- **THEN** deployment can drain the old API and deploy the API before replacing the web

### Requirement: Recover immediately after a failed replacement
Deployment SHALL record both previous immutable tags before mutation, stop or cancel unfinished replacement work before recovery, and attempt bounded restoration of the previous release on any post-drain failure. Recovery SHALL NOT wait for end-to-end tests. The failed rollout SHALL remain failed even when recovery succeeds, and recovery failure SHALL be explicit.

#### Scenario: API replacement fails
- **WHEN** the API deployment fails after the old writer stops
- **THEN** the coordinator restores the previous tag and attempts deployment and health verification before returning failure

#### Scenario: Web replacement fails
- **WHEN** the web deployment fails after the API becomes healthy
- **THEN** the coordinator attempts restoration of both applications in compatibility-safe order

#### Scenario: Recovery fails
- **WHEN** a bounded restoration cannot obtain a healthy previous release
- **THEN** the deployment reports recovery failure and the affected application identifiers without claiming success or printing credentials

### Requirement: Bound and isolate deployment work
Deployments SHALL stay serialized, use bounded requests and waits, and clean only preparation resources owned by that run. No preparation resource SHALL expose a public route, application secrets, persistent storage, or a privileged host mount.

#### Scenario: Preparation completes or fails
- **WHEN** the coordinator exits normally or with a handled error
- **THEN** it removes its temporary preparation service without removing cached images or unrelated resources
