# Desktop Shell Specification

## Purpose

Define the native desktop and frontend-shell behavior that makes Omni Agent Desktop a keyboard-first launcher while keeping native integration separate from agent business logic.

## Requirements

### Requirement: Launcher window control
The application SHALL provide a desktop window that can be shown or hidden with a configurable global shortcut and SHALL focus the window when it is shown.

#### Scenario: User invokes the launcher shortcut
- **WHEN** the configured global shortcut is pressed while the launcher is hidden or minimized
- **THEN** the application shows, restores, and focuses the main window

#### Scenario: User dismisses a visible launcher
- **WHEN** the configured global shortcut is pressed while the launcher is visible
- **THEN** the application hides the main window without terminating the application

### Requirement: Keyboard-first workspace
The frontend SHALL provide keyboard-accessible chat, session navigation, settings, help, and scheduled-task views while preserving the user's active conversation.

#### Scenario: User opens preferences
- **WHEN** the user invokes the preferences shortcut or activates the settings control
- **THEN** the application presents provider and application settings without discarding the active conversation

#### Scenario: User starts a new task
- **WHEN** the user invokes the new-task action
- **THEN** the application creates a new conversation and displays the chat workspace

### Requirement: Layered runtime boundary
The Rust shell SHALL own native desktop integration and sidecar lifecycle, and SHALL forward generic sidecar requests and events without duplicating provider or agent-loop business logic.

#### Scenario: Frontend invokes sidecar behavior
- **WHEN** the frontend calls a sidecar-backed command
- **THEN** the Rust shell forwards the mapped method and parameters to the TypeScript sidecar and returns its result or error

#### Scenario: Sidecar emits progress
- **WHEN** the sidecar emits a named runtime event
- **THEN** the Rust shell re-emits that event to the frontend under the same name

### Requirement: Thin-client product boundary
The desktop application MUST use provider APIs and configured A2A endpoints for extensible agent capability and MUST NOT become an OmniLauncher plugin runtime or an A2A routing hub.

#### Scenario: New remote capability is needed
- **WHEN** a feature requires capability beyond the desktop's native affordances and built-in agent tools
- **THEN** the design connects to a direct A2A agent or an A2A hub rather than loading an OmniLauncher plugin into the desktop process
