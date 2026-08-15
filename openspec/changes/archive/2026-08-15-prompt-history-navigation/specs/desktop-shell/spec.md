## ADDED Requirements

### Requirement: Composer prompt-history navigation
The frontend SHALL retain up to 50 accepted ordinary textual composer submissions in transient memory, newest first; SHALL skip blank textual content and consecutive duplicates after trimming outer whitespace; and SHALL exclude recognized slash commands and prompt sources that bypass the composer.

#### Scenario: Recall older prompts
- **WHEN** the composer contains a collapsed caret on its first logical line and the user presses unmodified ArrowUp after submitting multiple ordinary text prompts
- **THEN** the composer recalls the newest prompt first and continues toward older retained prompts on subsequent ArrowUp presses

#### Scenario: Return toward the current draft
- **WHEN** the user presses unmodified ArrowDown while browsing prompt history with a collapsed caret on the last logical line
- **THEN** the composer moves toward newer history entries and restores the exact draft that existed before browsing after moving past the newest entry

#### Scenario: Preserve multiline navigation and selections
- **WHEN** the caret is not at the applicable logical-line boundary, a text selection is active, or an arrow key has Shift, Alt, Control, or Meta modifiers
- **THEN** the composer preserves native textarea navigation or selection behavior instead of recalling a prompt

#### Scenario: Slash autocomplete takes precedence
- **WHEN** slash autocomplete is open with matching commands and the user presses ArrowUp or ArrowDown
- **THEN** the highlighted slash command changes and the composer does not recall prompt history

#### Scenario: Editing recalled text exits browsing
- **WHEN** the user edits text recalled from prompt history
- **THEN** history browsing ends without changing the stored history entry, and a later ArrowUp begins a new traversal from the edited draft

#### Scenario: Retain only accepted textual composer submissions
- **WHEN** an ordinary prompt with non-blank text is accepted through the composer
- **THEN** its trimmed text becomes the newest retained entry unless it duplicates the current newest entry

#### Scenario: Exclude non-history prompt sources
- **WHEN** the user runs a recognized slash command, sends an image without non-blank text, activates a welcome suggestion, or triggers another prompt source that bypasses the composer
- **THEN** no prompt-history entry is added for that action

#### Scenario: Disabled ordinary submission preserves the draft
- **WHEN** an ordinary prompt is present while submission is disabled and the user presses Enter or activates Send
- **THEN** the prompt remains in the composer, is not sent, and is not added to prompt history

#### Scenario: History lifetime is transient
- **WHEN** the composer remains mounted while the user switches conversations
- **THEN** retained prompt history remains available across those conversations
- **AND** the history is cleared when the composer unmounts or the application reloads
