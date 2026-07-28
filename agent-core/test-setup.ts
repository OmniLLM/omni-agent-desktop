/**
 * Test preload: redirect all on-disk state to a scratch directory.
 *
 * `configDir()` resolves OMNI_AGENT_HOME before any platform default, so
 * setting it here keeps logs, settings, sessions and memory written during
 * tests out of the user's real %APPDATA%/omni-agent-desktop. Loaded via
 * `preload` in bunfig.toml so it applies to every test file.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.OMNI_AGENT_HOME) {
  process.env.OMNI_AGENT_HOME = mkdtempSync(join(tmpdir(), "omni-agent-test-"));
}

// Silence run/A2A diagnostics during tests so assertion failures stand out.
// Set OMNI_AGENT_QUIET_LOG=0 to see them when debugging a specific test.
if (!process.env.OMNI_AGENT_QUIET_LOG) process.env.OMNI_AGENT_QUIET_LOG = "1";
