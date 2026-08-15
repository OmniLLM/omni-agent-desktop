# Provider Configuration Specification

## Purpose

Define how users configure, validate, select, and securely use model providers across supported API shapes.

## Requirements

### Requirement: Independent provider profiles
The application SHALL maintain independent configuration profiles for Custom Provider, GitHub Copilot, and Azure Foundry, and SHALL preserve inactive profiles when the active provider changes.

#### Scenario: User switches providers
- **WHEN** the user selects a different configured provider
- **THEN** the application activates that provider's saved endpoint, API shape, model, and provider-specific settings without overwriting other profiles

### Requirement: Supported API shapes
The Custom Provider profile SHALL support OpenAI-compatible Chat Completions, Anthropic Messages, and OpenAI Responses request shapes, while provider-specific profiles SHALL use the compatible transport for their service.

#### Scenario: User selects an API shape
- **WHEN** a valid Custom Provider profile is saved with a supported API shape
- **THEN** subsequent inference uses the adapter for that shape

### Requirement: Configuration validation
The application SHALL reject activation of a provider profile that lacks the fields or authentication state required by that provider.

#### Scenario: Custom provider is incomplete
- **WHEN** the Custom Provider profile lacks an endpoint, API key, or model
- **THEN** the application reports the missing field and does not treat the profile as ready

#### Scenario: Copilot is disconnected
- **WHEN** GitHub Copilot is selected without an authenticated Copilot session
- **THEN** the application instructs the user to connect Copilot before activation

#### Scenario: Azure mapping is invalid
- **WHEN** Azure Foundry has missing or duplicate model-to-deployment mappings, lacks an API version, or selects a model outside its mappings
- **THEN** the application reports the validation error and prevents use of the invalid configuration

### Requirement: Model selection and discovery
The application SHALL support model discovery where a provider exposes it and SHALL support a validated manual model or deployment list where discovery is unavailable.

#### Scenario: Provider returns models
- **WHEN** the user requests model discovery for a configured provider and the provider responds successfully
- **THEN** the application presents the compatible models for selection

#### Scenario: Discovery is unavailable
- **WHEN** the provider does not expose model discovery
- **THEN** the user can configure an explicit model or deployment mapping and select from that configuration

### Requirement: Protected credential handling
Protected provider credentials MUST be stored outside plaintext settings and MUST NOT be returned to frontend state, events, logs, or persisted profile JSON; the frontend MAY receive only a non-secret presence indicator.

#### Scenario: Frontend reads settings
- **WHEN** settings include a stored protected provider credential
- **THEN** the frontend receives a blank secret value and an indicator that a credential is configured

#### Scenario: User removes a protected credential
- **WHEN** the user explicitly clears a protected provider credential and saves settings
- **THEN** the system removes the credential from protected storage without writing it to plaintext settings

### Requirement: Backward-compatible settings migration
The application SHALL load legacy flat provider settings into the current provider-profile model without losing the user's effective endpoint, model, API key, or inferred API shape.

#### Scenario: Profile map is absent
- **WHEN** existing settings contain only legacy flat AI fields
- **THEN** the system creates a Custom Provider profile from those fields and continues with valid defaults for new settings
