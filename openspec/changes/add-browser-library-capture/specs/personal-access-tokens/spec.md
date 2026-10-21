## MODIFIED Requirements

### Requirement: Session-managed personal tokens
The system SHALL let an authenticated user create, list and revoke personal tokens in Settings. Tokens SHALL have a name, read, read/write or capture-only access, expiration no later than one year, and last-use metadata. The secret SHALL be displayed only when created, stored only as a digest, and excluded from logs and later list responses. Capture-only access SHALL be clearly distinguished from MCP access.

#### Scenario: Create and revoke
- **WHEN** a signed-in user creates a token and subsequently revokes it
- **THEN** creation returns the secret once and subsequent authenticated requests with that token fail

#### Scenario: Isolation and privilege escalation
- **WHEN** a different user or an MCP token attempts to manage the first user's tokens
- **THEN** the operation is denied and no token secrets or metadata are disclosed

### Requirement: Fail-closed token authentication
MCP SHALL require a valid, unexpired, unrevoked bearer token with read or read/write scope and derive ownership exclusively from that credential. Cookie sessions, capture-only tokens and tokens in URL parameters SHALL NOT authorize MCP. Read-only tokens SHALL NOT propose or apply mutations.

#### Scenario: Read-only access
- **WHEN** a read-only token requests tools or attempts a write by name
- **THEN** discovery exposes read tools only and direct mutation calls are rejected

#### Scenario: Capture token at MCP
- **WHEN** a capture-only credential attempts to initialize or call MCP
- **THEN** authorization is rejected before exposing a tool catalog or private resource

#### Scenario: Optional AI configuration
- **WHEN** no AI provider is configured
- **THEN** token management and ordinary knowledge operations remain available
