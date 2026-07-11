//! Cross-session memory following the Harness Engineering Guide two-tier model.
//!
//!  * Tier 1 — daily logs (`memory/YYYY-MM-DD.md`): append-only, chronological
//!    records written automatically during sessions.
//!  * Tier 2 — long-term memory (`MEMORY.md`): curated, distilled knowledge the
//!    user edits or the agent updates deliberately.
//!
//! At session startup the harness reads `MEMORY.md` plus today's and
//! yesterday's daily logs and injects them into context.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Directory holding daily logs, alongside `MEMORY.md` in `base`.
fn memory_dir(base: &Path) -> PathBuf {
    base.join("memory")
}

/// Path to the curated long-term memory file.
pub fn memory_file(base: &Path) -> PathBuf {
    base.join("MEMORY.md")
}

/// Convert a unix-epoch day count to a proleptic Gregorian `YYYY-MM-DD` string.
/// Dependency-free (no chrono); correct for all dates after 1970.
fn ymd_from_days(days: i64) -> String {
    // Algorithm from Howard Hinnant's `civil_from_days`.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Whole days since the unix epoch (UTC), or 0 before 1970.
fn today_days() -> i64 {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    secs / 86_400
}

/// The date string for a daily log `days_ago` before today (0 = today).
fn log_date(days_ago: i64) -> String {
    ymd_from_days(today_days() - days_ago)
}

/// Path to the daily log for `days_ago` before today.
fn daily_log_path(base: &Path, days_ago: i64) -> PathBuf {
    memory_dir(base).join(format!("{}.md", log_date(days_ago)))
}

/// Append a timestamped entry to today's daily log. Best-effort: failures are
/// swallowed (memory writes must never break a run).
pub fn append_daily_log(base: &Path, entry: &str) {
    let dir = memory_dir(base);
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = daily_log_path(base, 0);
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let hh = (secs % 86_400) / 3600;
    let mm = (secs % 3600) / 60;
    let line = format!("- {hh:02}:{mm:02} UTC — {}\n", entry.replace('\n', " "));
    if let Ok(existing) = fs::read_to_string(&path) {
        let _ = fs::write(&path, format!("{existing}{line}"));
    } else {
        let header = format!("# Daily log {}\n\n", log_date(0));
        let _ = fs::write(&path, format!("{header}{line}"));
    }
}

/// Read startup memory: `MEMORY.md` (always) plus today's and yesterday's daily
/// logs. Sections are joined with `\n---\n`. Returns an empty string when no
/// memory exists yet.
pub fn read_startup_memory(base: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();

    if let Ok(mem) = fs::read_to_string(memory_file(base)) {
        let mem = mem.trim();
        if !mem.is_empty() {
            parts.push(format!("# Long-term memory (MEMORY.md)\n{mem}"));
        }
    }
    for days_ago in 0..=1 {
        if let Ok(log) = fs::read_to_string(daily_log_path(base, days_ago)) {
            let log = log.trim();
            if !log.is_empty() {
                parts.push(log.to_string());
            }
        }
    }
    parts.join("\n---\n")
}

/// Read the raw contents of `MEMORY.md` (empty string if absent).
pub fn get_memory(base: &Path) -> String {
    fs::read_to_string(memory_file(base)).unwrap_or_default()
}

/// Overwrite `MEMORY.md` with `content`.
pub fn save_memory(base: &Path, content: &str) -> Result<(), String> {
    fs::create_dir_all(base).map_err(|e| e.to_string())?;
    fs::write(memory_file(base), content).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "omni-mem-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn ymd_conversion_known_dates() {
        assert_eq!(ymd_from_days(0), "1970-01-01");
        assert_eq!(ymd_from_days(18_993), "2022-01-01");
        assert_eq!(ymd_from_days(19_000), "2022-01-08");
    }

    #[test]
    fn save_and_get_memory_roundtrip() {
        let base = tmp();
        assert_eq!(get_memory(&base), "");
        save_memory(&base, "# Prefs\nUse dark theme.").unwrap();
        assert_eq!(get_memory(&base), "# Prefs\nUse dark theme.");
    }

    #[test]
    fn startup_memory_includes_memory_and_daily_log() {
        let base = tmp();
        save_memory(&base, "User prefers concise answers.").unwrap();
        append_daily_log(&base, "Answered a question about disk usage.");
        let startup = read_startup_memory(&base);
        assert!(startup.contains("Long-term memory"));
        assert!(startup.contains("User prefers concise answers."));
        assert!(startup.contains("disk usage"));
    }

    #[test]
    fn append_daily_log_accumulates() {
        let base = tmp();
        append_daily_log(&base, "first");
        append_daily_log(&base, "second");
        let log = fs::read_to_string(daily_log_path(&base, 0)).unwrap();
        assert!(log.contains("first"));
        assert!(log.contains("second"));
    }

    #[test]
    fn empty_memory_returns_empty_startup() {
        let base = tmp();
        assert_eq!(read_startup_memory(&base), "");
    }
}
