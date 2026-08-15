# Screen Capture Specification

## Purpose

Define native region screenshot and screen-text capture flows used to attach visual context or insert locally recognized text into a prompt.

## Requirements

### Requirement: Interactive region screenshot
The application SHALL hide its own window, invoke the operating system's interactive region selector, restore and focus the window afterward, and return a non-empty PNG as a provider-neutral image attachment.

#### Scenario: User completes a screenshot selection
- **WHEN** the user selects a screen region through the screenshot action
- **THEN** the application restores the launcher and attaches the selected PNG with its MIME type and name

#### Scenario: User cancels selection
- **WHEN** the native region selector is cancelled or produces no image
- **THEN** the application restores the launcher, reports cancellation without attaching an empty image, and removes temporary data

### Requirement: Provider-neutral image transport
The frontend SHALL represent a captured image as a data URL and the agent runtime SHALL convert it to the active provider's supported multimodal content shape.

#### Scenario: Image prompt is sent
- **WHEN** the user submits a prompt containing a captured PNG
- **THEN** the active provider receives an equivalent native image content block rather than filesystem-only metadata

### Requirement: Local screen-text recognition
When screen-text selection is enabled, the application SHALL let the user select a region, perform OCR locally through the supported operating-system facility, and insert recognized text into the composer for review before sending.

#### Scenario: OCR finds text
- **WHEN** a user selects a region containing recognizable text
- **THEN** the application inserts the trimmed text into the composer and does not send it until the user submits the prompt

#### Scenario: OCR is unsupported
- **WHEN** screen-text recognition is requested on an unsupported platform
- **THEN** the application returns an explicit unsupported-platform error and restores the launcher

### Requirement: Capture cleanup
The application MUST remove temporary screenshot files after reading or recognizing them and SHALL clean up operating-system capture UI that it opened without closing pre-existing user windows.

#### Scenario: Capture completes on Windows
- **WHEN** the application has opened a new Snipping Tool window for a capture
- **THEN** cleanup may close only newly detected Snipping Tool windows associated with that capture and leaves pre-existing windows untouched
