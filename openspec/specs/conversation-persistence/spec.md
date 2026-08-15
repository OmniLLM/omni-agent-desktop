# Conversation Persistence Specification

## Purpose

Define durable conversation sessions and cross-session memory so users can resume work without mixing local notices into model context.

## Requirements

### Requirement: Durable sessions
The application SHALL persist each conversation as a distinct session with an identifier, title, messages, creation time, and update time.

#### Scenario: Conversation changes
- **WHEN** messages or the title of a session change
- **THEN** the application writes the updated session while preserving its original creation time

#### Scenario: Application restarts
- **WHEN** the application starts after sessions have been saved
- **THEN** the user can list and load those sessions with their messages intact

### Requirement: Session lifecycle
The user SHALL be able to create, select, rename, and delete sessions, and the session list SHALL remain ordered by creation time rather than recent access.

#### Scenario: Existing session is opened
- **WHEN** the user selects and loads an older session
- **THEN** the session's position in the creation-ordered list does not change merely because it was opened

#### Scenario: Session is deleted
- **WHEN** the user confirms deletion of a session
- **THEN** its persisted session file is removed and it no longer appears in the session list

### Requirement: Model-context filtering
Frontend-only system notices SHALL remain visible in the conversation UI but MUST NOT be sent back to the model as conversation history.

#### Scenario: Slash command emits a local notice
- **WHEN** a slash command adds an informational or warning notice to the chat
- **THEN** the notice is rendered for the user and excluded from the next provider request

### Requirement: Cross-session memory
The application SHALL support curated long-term memory and recent daily logs stored under the application configuration directory and SHALL make startup memory available to agent execution.

#### Scenario: Agent starts with saved memory
- **WHEN** curated memory or logs for today or the previous day exist
- **THEN** the system can include that memory context in a subsequent agent run

#### Scenario: Daily event is recorded
- **WHEN** the system appends a memory log entry
- **THEN** it stores a timestamped single-line entry in the current UTC day's log without failing the user operation if best-effort logging is unavailable

### Requirement: Corrupt persistence isolation
A corrupt session-list entry or optional memory file SHALL NOT prevent other valid sessions or the application itself from loading.

#### Scenario: One session file is malformed
- **WHEN** the session directory contains both valid and malformed JSON files
- **THEN** the application lists the valid sessions and skips the malformed entry
