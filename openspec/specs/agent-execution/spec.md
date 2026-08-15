# Agent Execution Specification

## Purpose

Define how Omni Agent Desktop sends conversational work to a configured model, executes tools, reports progress, and enforces user-selected safety modes.

## Requirements

### Requirement: Provider-driven agent loop
The system SHALL send the conversation, system instructions, and available tool definitions to the active provider and SHALL continue model/tool turns until the provider returns a final response or the configured iteration limit is reached.

#### Scenario: Provider returns a final response
- **WHEN** the active provider returns text without any tool calls
- **THEN** the system ends the run and presents that text as the assistant response

#### Scenario: Iteration limit is reached
- **WHEN** the run consumes the configured maximum number of model/tool iterations without a final response
- **THEN** the system stops the loop and returns an explicit maximum-iterations result

### Requirement: Tool execution modes
The system SHALL enforce `plan`, `ask`, and `autopilot` run modes for mutating local tools and A2A tools while allowing read-only local tools to run without approval.

#### Scenario: Mutating tool in plan mode
- **WHEN** the model requests a mutating tool while the run mode is `plan`
- **THEN** the system blocks the tool and returns a blocked result to the model

#### Scenario: Mutating tool in ask mode
- **WHEN** the model requests a mutating tool while the run mode is `ask`
- **THEN** the system requests user approval before executing the tool

#### Scenario: Tool in autopilot mode
- **WHEN** the model requests an available tool while the run mode is `autopilot`
- **THEN** the system executes the tool without an approval prompt

#### Scenario: Read-only tool in any mode
- **WHEN** the model requests a read-only local tool
- **THEN** the system executes it without prompting for approval

### Requirement: Approval isolation
The system MUST correlate every approval decision to the exact run and tool call that requested it, and an unanswered approval SHALL default to denial after its timeout.

#### Scenario: Concurrent runs reuse a provider call identifier
- **WHEN** two runs contain tool calls with the same provider-native identifier
- **THEN** an approval decision for one run cannot resolve the other run's pending request

#### Scenario: Approval expires
- **WHEN** no decision is received before the approval timeout
- **THEN** the system denies that tool call and continues with a denial result

### Requirement: Observable run progress
The system SHALL emit distinct events for model thoughts, tool calls, tool results, approval requests, completion, cancellation, and errors so the frontend can represent run state accurately.

#### Scenario: A tool completes
- **WHEN** an invoked tool returns a result or execution error
- **THEN** the frontend receives a tool-result event correlated with the original tool-call event

### Requirement: Run cancellation
The user SHALL be able to cancel an active session run, including in-flight provider work, without marking the cancellation as an ordinary provider failure.

#### Scenario: User cancels active inference
- **WHEN** the user requests cancellation while provider inference is in progress
- **THEN** the system aborts the run and emits a cancellation outcome for that session
