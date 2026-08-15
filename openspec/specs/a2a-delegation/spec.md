# A2A Delegation Specification

## Purpose

Define how the desktop discovers remote A2A capabilities, exposes them to the model as tools, and delegates work safely to direct agents or hubs.

## Requirements

### Requirement: Agent-card discovery
The application SHALL discover each enabled A2A connection through its agent card and SHALL derive callable tools from enabled skills in that card.

#### Scenario: Enabled connection exposes skills
- **WHEN** an enabled connection returns an agent card containing skills
- **THEN** the system creates a stable, provider-safe tool definition for every skill not disabled by the user

#### Scenario: Skill is disabled
- **WHEN** a discovered skill is listed in the connection's disabled skills
- **THEN** the system does not expose that skill as a callable tool

### Requirement: Collision-resistant tool names
Every A2A skill tool name MUST be valid for provider tool APIs, no longer than 64 characters, and stable for the same connection and skill identifiers.

#### Scenario: Skill identifier exceeds the provider limit
- **WHEN** sanitizing a connection and skill identifier would produce a name longer than 64 characters
- **THEN** the system truncates the readable portion and appends a deterministic hash to preserve distinction

### Requirement: Credential-safe endpoint handling
The system MUST NOT send a configured A2A bearer token to an endpoint on a different origin merely because that endpoint was advertised by an agent card.

#### Scenario: Card advertises a same-origin endpoint
- **WHEN** the card endpoint has the same scheme, host, and port as the configured endpoint
- **THEN** the system may delegate to the advertised endpoint with the configured token

#### Scenario: Card advertises a cross-origin endpoint
- **WHEN** the card endpoint differs in scheme, host, or port from the configured endpoint or cannot be parsed
- **THEN** the system pins delegation to the configured endpoint and does not leak the token cross-origin

### Requirement: Skill-targeted delegation
The system SHALL send delegated work through A2A JSON-RPC `message/send` with the selected skill identifier and user task in the request.

#### Scenario: Model invokes an A2A skill
- **WHEN** the model calls a discovered A2A tool with task text
- **THEN** the system sends the task to that tool's connection and explicitly identifies the selected skill for routing

### Requirement: Asynchronous task completion
The system SHALL poll a non-terminal A2A task until it reaches a terminal state or the configured A2A timeout expires, and SHALL support both canonical A2A enum state names and legacy short state names.

#### Scenario: Delegation returns a working task
- **WHEN** `message/send` returns a task whose state is not terminal
- **THEN** the system polls `tasks/get` until completion, cancellation, failure, input requirement, or timeout

#### Scenario: Delegated task succeeds
- **WHEN** the task reaches a completed state with text in its message, status, artifacts, or history
- **THEN** the system returns the extracted text as the tool result

#### Scenario: Delegated task produces no usable output
- **WHEN** a terminal task contains no text result
- **THEN** the system returns an explicit error rather than an empty successful result

#### Scenario: Delegation authentication fails
- **WHEN** the A2A endpoint responds with HTTP 401 or 403
- **THEN** the system reports whether the configured bearer token was missing or rejected and identifies the affected connection
