//! Local tool registry: definitions, classification, and native executors.

use serde_json::{json, Value};
use std::fs;
use std::path::Path;

/// Whether a tool mutates local state (files/process) or is read-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolClass {
    ReadOnly,
    Mutating,
}

/// The seven built-in local tools.
pub const LOCAL_TOOLS: [&str; 7] = ["read", "ls", "glob", "grep", "write", "edit", "bash"];

pub fn classify(tool: &str) -> ToolClass {
    match tool {
        "read" | "ls" | "glob" | "grep" => ToolClass::ReadOnly,
        _ => ToolClass::Mutating,
    }
}

/// JSON-schema tool definitions in OpenAI `tools` array format.
pub fn tool_definitions() -> Vec<Value> {
    fn def(name: &str, desc: &str, props: Value, required: Vec<&str>) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": name,
                "description": desc,
                "parameters": {
                    "type": "object",
                    "properties": props,
                    "required": required,
                }
            }
        })
    }
    vec![
        def(
            "read",
            "Read a UTF-8 text file.",
            json!({"path": {"type": "string"}}),
            vec!["path"],
        ),
        def(
            "ls",
            "List entries in a directory.",
            json!({"path": {"type": "string"}}),
            vec!["path"],
        ),
        def(
            "glob",
            "List files matching a glob pattern.",
            json!({"pattern": {"type": "string"}}),
            vec!["pattern"],
        ),
        def(
            "grep",
            "Search files for a regex; returns matching lines.",
            json!({"pattern": {"type": "string"}, "path": {"type": "string"}}),
            vec!["pattern", "path"],
        ),
        def(
            "write",
            "Create or overwrite a file with content.",
            json!({"path": {"type": "string"}, "content": {"type": "string"}}),
            vec!["path", "content"],
        ),
        def(
            "edit",
            "Replace the first occurrence of old_string with new_string in a file.",
            json!({"path": {"type": "string"}, "old_string": {"type": "string"}, "new_string": {"type": "string"}}),
            vec!["path", "old_string", "new_string"],
        ),
        def(
            "bash",
            "Run a shell command and return combined stdout/stderr.",
            json!({"command": {"type": "string"}}),
            vec!["command"],
        ),
    ]
}

/// Execute a local tool. Returns Ok(result_text) or Err(error_text). Errors are
/// returned to the model as tool results, never as fatal loop errors.
pub fn execute(tool: &str, args: &Value) -> Result<String, String> {
    match tool {
        "read" => exec_read(args),
        "ls" => exec_ls(args),
        "glob" => exec_glob(args),
        "grep" => exec_grep(args),
        "write" => exec_write(args),
        "edit" => exec_edit(args),
        "bash" => exec_bash(args),
        other => Err(format!("unknown tool: {other}")),
    }
}

fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing string arg: {key}"))
}

fn exec_read(args: &Value) -> Result<String, String> {
    let path = arg_str(args, "path")?;
    fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))
}

fn exec_ls(args: &Value) -> Result<String, String> {
    let path = arg_str(args, "path")?;
    let mut names: Vec<String> = fs::read_dir(&path)
        .map_err(|e| format!("ls {path}: {e}"))?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    Ok(names.join("\n"))
}

fn exec_glob(args: &Value) -> Result<String, String> {
    let pattern = arg_str(args, "pattern")?;
    let mut out = Vec::new();
    for entry in glob::glob(&pattern).map_err(|e| format!("glob: {e}"))? {
        if let Ok(p) = entry {
            out.push(p.to_string_lossy().to_string());
        }
    }
    Ok(out.join("\n"))
}

fn exec_grep(args: &Value) -> Result<String, String> {
    let pattern = arg_str(args, "pattern")?;
    let path = arg_str(args, "path")?;
    let re = regex::Regex::new(&pattern).map_err(|e| format!("bad regex: {e}"))?;
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(&path)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let p = entry.path();
        if let Ok(text) = fs::read_to_string(p) {
            for (i, line) in text.lines().enumerate() {
                if re.is_match(line) {
                    out.push(format!("{}:{}:{}", p.display(), i + 1, line));
                }
            }
        }
    }
    Ok(out.join("\n"))
}

fn exec_write(args: &Value) -> Result<String, String> {
    let path = arg_str(args, "path")?;
    let content = arg_str(args, "content")?;
    if let Some(parent) = Path::new(&path).parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&path, &content).map_err(|e| format!("write {path}: {e}"))?;
    Ok(format!("wrote {} bytes to {path}", content.len()))
}

fn exec_edit(args: &Value) -> Result<String, String> {
    let path = arg_str(args, "path")?;
    let old = arg_str(args, "old_string")?;
    let new = arg_str(args, "new_string")?;
    let text = fs::read_to_string(&path).map_err(|e| format!("edit {path}: {e}"))?;
    if !text.contains(&old) {
        return Err(format!("old_string not found in {path}"));
    }
    let updated = text.replacen(&old, &new, 1);
    fs::write(&path, updated).map_err(|e| format!("edit {path}: {e}"))?;
    Ok(format!("edited {path}"))
}

fn exec_bash(args: &Value) -> Result<String, String> {
    let command = arg_str(args, "command")?;
    let output = if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .args(["/C", &command])
            .output()
    } else {
        std::process::Command::new("sh")
            .args(["-c", &command])
            .output()
    }
    .map_err(|e| format!("bash spawn: {e}"))?;
    let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
    let err = String::from_utf8_lossy(&output.stderr);
    if !err.is_empty() {
        combined.push_str(&err);
    }
    Ok(combined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification_splits_read_and_mutating() {
        assert_eq!(classify("read"), ToolClass::ReadOnly);
        assert_eq!(classify("grep"), ToolClass::ReadOnly);
        assert_eq!(classify("write"), ToolClass::Mutating);
        assert_eq!(classify("bash"), ToolClass::Mutating);
        assert_eq!(classify("edit"), ToolClass::Mutating);
    }
}

#[cfg(test)]
mod def_tests {
    use super::*;

    #[test]
    fn definitions_cover_all_local_tools() {
        let defs = tool_definitions();
        let names: Vec<String> = defs
            .iter()
            .map(|d| d["function"]["name"].as_str().unwrap().to_string())
            .collect();
        for t in LOCAL_TOOLS {
            assert!(names.contains(&t.to_string()), "missing {t}");
        }
        assert_eq!(defs.len(), 7);
    }
}

#[cfg(test)]
mod exec_tests {
    use super::*;
    use serde_json::json;

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "omni-tools-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn write_then_read_roundtrips() {
        let d = tmp();
        let f = d.join("a.txt");
        let fp = f.to_string_lossy().to_string();
        execute("write", &json!({"path": fp, "content": "hello"})).unwrap();
        let got = execute("read", &json!({"path": fp})).unwrap();
        assert_eq!(got, "hello");
    }

    #[test]
    fn edit_replaces_first_occurrence() {
        let d = tmp();
        let f = d.join("b.txt");
        let fp = f.to_string_lossy().to_string();
        execute("write", &json!({"path": fp, "content": "foo foo"})).unwrap();
        execute(
            "edit",
            &json!({"path": fp, "old_string": "foo", "new_string": "bar"}),
        )
        .unwrap();
        let got = execute("read", &json!({"path": fp})).unwrap();
        assert_eq!(got, "bar foo");
    }

    #[test]
    fn edit_missing_string_errors() {
        let d = tmp();
        let f = d.join("c.txt");
        let fp = f.to_string_lossy().to_string();
        execute("write", &json!({"path": fp, "content": "x"})).unwrap();
        assert!(execute(
            "edit",
            &json!({"path": fp, "old_string": "zzz", "new_string": "y"})
        )
        .is_err());
    }

    #[test]
    fn ls_and_glob_list_files() {
        let d = tmp();
        let fp = d.join("only.txt");
        std::fs::write(&fp, "1").unwrap();
        let ls = execute("ls", &json!({"path": d.to_string_lossy()})).unwrap();
        assert!(ls.contains("only.txt"));
        let g = execute("glob", &json!({"pattern": d.join("*.txt").to_string_lossy()})).unwrap();
        assert!(g.contains("only.txt"));
    }

    #[test]
    fn grep_finds_matching_line() {
        let d = tmp();
        std::fs::write(d.join("g.txt"), "alpha\nbeta\n").unwrap();
        let out = execute("grep", &json!({"pattern": "bet", "path": d.to_string_lossy()})).unwrap();
        assert!(out.contains("beta"));
    }

    #[test]
    fn bash_echoes() {
        let out = execute("bash", &json!({"command": "echo hi"})).unwrap();
        assert!(out.contains("hi"));
    }
}
