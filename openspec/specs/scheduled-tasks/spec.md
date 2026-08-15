# Scheduled Tasks Specification

## Purpose

Define persistent one-shot and recurring prompts that execute through the same agent runtime and expose their status to the desktop UI.

## Requirements

### Requirement: Persistent scheduled prompts
The application SHALL let users create, list, update, and delete scheduled prompts and SHALL persist them under the application configuration directory.

#### Scenario: User creates a scheduled prompt
- **WHEN** the user supplies a prompt and valid cadence
- **THEN** the system assigns its next execution time, persists the task, and returns it in subsequent listings

#### Scenario: User deletes a task
- **WHEN** the user deletes an existing scheduled task
- **THEN** the system removes it from persistent storage and future scheduler ticks do not execute it

### Requirement: One-shot and recurring cadence
The scheduler SHALL support a one-shot fire time and a recurring interval of at least 60 seconds.

#### Scenario: One-shot task becomes due
- **WHEN** the current time reaches or passes a one-shot task's fire time
- **THEN** the scheduler executes that task once and prevents it from immediately becoming due again

#### Scenario: Recurring task succeeds
- **WHEN** a recurring task completes successfully
- **THEN** the scheduler records its last-fire time and computes the next fire time from the configured interval

### Requirement: Shared agent execution
Scheduled prompts SHALL execute through the same provider, tool, A2A, settings, and safety runtime used by foreground prompts rather than a separate agent implementation.

#### Scenario: Scheduled prompt fires
- **WHEN** a task reaches its due time or the user selects run-now
- **THEN** the scheduler invokes the shared agent execution path with that task's prompt

### Requirement: Status reporting
The scheduler SHALL persist and emit status transitions for running, successful, and failed executions without including protected credentials.

#### Scenario: Task begins
- **WHEN** the scheduler starts a task
- **THEN** it marks the task as running and emits a correlated scheduler status event

#### Scenario: Task fails
- **WHEN** scheduled execution raises an error
- **THEN** the scheduler records a bounded actionable error, emits a failed status, and remains available to process other tasks

### Requirement: Immediate execution
The user SHALL be able to run an existing scheduled task immediately without waiting for its next due time.

#### Scenario: User selects run-now
- **WHEN** run-now is requested for an existing task
- **THEN** the scheduler executes it and persists the resulting status using the normal scheduled-task path
