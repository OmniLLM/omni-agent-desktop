//! Native agent core: local tools, provider client, A2A bridge, run-mode gating,
//! and the agent loop.

pub mod a2a;
pub mod context;
pub mod provider;
pub mod tools;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

// ---------------------------------------------------------------------------
// Run modes and gating
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunMode {
    Plan,
    Ask,
    Autopilot,
}

impl Default for RunMode {
    fn default() -> Self {
        RunMode::Ask
    }
}

/// Decision for a tool call under a run mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    /// Run immediately.
    Auto,
    /// Ask the user first.
    Approve,
    /// Refuse; return a not-permitted result to the model.
    Block,
}

/// Gate a tool by whether it mutates state and the active run mode. A2A tools are
/// treated as mutating (`is_mutating = true`).
pub fn gate(mode: RunMode, is_mutating: bool) -> Gate {
    match (mode, is_mutating) {
        (_, false) => Gate::Auto,
        (RunMode::Plan, true) => Gate::Block,
        (RunMode::Ask, true) => Gate::Approve,
        (RunMode::Autopilot, true) => Gate::Auto,
    }
}

// ---------------------------------------------------------------------------
// Synchronous agent loop (unit-testable; production uses an async mirror)
// ---------------------------------------------------------------------------

/// One message in the running conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConvMsg {
    pub role: String,
    pub content: String,
}

/// Outcome of a completed run.
#[derive(Debug, Clone, PartialEq)]
pub struct RunResult {
    pub reply: String,
    pub tools_used: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    Approve,
    Deny,
    AllowSession,
}

/// A decision source for gated tools. In production this waits on the UI; in
/// tests it returns a fixed decision.
pub trait Approver {
    fn approve(&mut self, tool: &str, args: &Value) -> ApprovalDecision;
}

/// Run the agent loop. `provider_call` maps the message list to a parsed turn.
/// `run_tool` executes a resolved tool (local or A2A) and returns a result text.
///
/// This synchronous form is the reference implementation exercised by unit
/// tests; `main.rs` runs an async mirror that awaits provider/A2A HTTP calls.
#[allow(dead_code, clippy::too_many_arguments)]
pub fn run_loop<P, T, A, M>(
    mode: RunMode,
    max_iterations: usize,
    mut messages: Vec<ConvMsg>,
    is_mutating: M,
    mut provider_call: P,
    mut run_tool: T,
    approver: &mut A,
) -> RunResult
where
    P: FnMut(&[ConvMsg]) -> provider::ParsedTurn,
    T: FnMut(&str, &Value) -> Result<String, String>,
    A: Approver,
    M: Fn(&str) -> bool,
{
    let mut tools_used = Vec::new();
    let mut session_allow: HashSet<String> = HashSet::new();
    for _ in 0..max_iterations {
        let turn = provider_call(&messages);
        if turn.tool_calls.is_empty() {
            return RunResult {
                reply: turn.text,
                tools_used,
            };
        }
        for call in &turn.tool_calls {
            let mutating = is_mutating(&call.name);
            let decision = match gate(mode, mutating) {
                Gate::Auto => ApprovalDecision::Approve,
                Gate::Block => {
                    messages.push(ConvMsg {
                        role: "tool".into(),
                        content: format!("{}: not permitted in plan mode", call.name),
                    });
                    continue;
                }
                Gate::Approve => {
                    if session_allow.contains(&call.name) {
                        ApprovalDecision::Approve
                    } else {
                        approver.approve(&call.name, &call.args)
                    }
                }
            };
            match decision {
                ApprovalDecision::Deny => {
                    messages.push(ConvMsg {
                        role: "tool".into(),
                        content: format!("{}: denied by user", call.name),
                    });
                }
                ApprovalDecision::AllowSession | ApprovalDecision::Approve => {
                    if decision == ApprovalDecision::AllowSession {
                        session_allow.insert(call.name.clone());
                    }
                    tools_used.push(call.name.clone());
                    let result =
                        run_tool(&call.name, &call.args).unwrap_or_else(|e| format!("error: {e}"));
                    messages.push(ConvMsg {
                        role: "tool".into(),
                        content: result,
                    });
                }
            }
        }
    }
    RunResult {
        reply: "stopped: max iterations reached".into(),
        tools_used,
    }
}

#[cfg(test)]
mod gate_tests {
    use super::*;

    #[test]
    fn read_only_always_auto() {
        for m in [RunMode::Plan, RunMode::Ask, RunMode::Autopilot] {
            assert_eq!(gate(m, false), Gate::Auto);
        }
    }

    #[test]
    fn mutating_gated_by_mode() {
        assert_eq!(gate(RunMode::Plan, true), Gate::Block);
        assert_eq!(gate(RunMode::Ask, true), Gate::Approve);
        assert_eq!(gate(RunMode::Autopilot, true), Gate::Auto);
    }

    #[test]
    fn default_mode_is_ask() {
        assert_eq!(RunMode::default(), RunMode::Ask);
    }
}

#[cfg(test)]
mod loop_tests {
    use super::provider::{ParsedTurn, ToolCall};
    use super::*;
    use serde_json::json;

    struct AutoApprove;
    impl Approver for AutoApprove {
        fn approve(&mut self, _t: &str, _a: &Value) -> ApprovalDecision {
            ApprovalDecision::Approve
        }
    }
    struct DenyAll;
    impl Approver for DenyAll {
        fn approve(&mut self, _t: &str, _a: &Value) -> ApprovalDecision {
            ApprovalDecision::Deny
        }
    }

    fn scripted(turns: Vec<ParsedTurn>) -> impl FnMut(&[ConvMsg]) -> ParsedTurn {
        let mut i = 0;
        move |_m| {
            let t = turns[i.min(turns.len() - 1)].clone();
            i += 1;
            t
        }
    }

    #[test]
    fn returns_text_when_no_tool_calls() {
        let mut approver = AutoApprove;
        let r = run_loop(
            RunMode::Ask,
            5,
            vec![],
            |_| false,
            scripted(vec![ParsedTurn {
                text: "done".into(),
                tool_calls: vec![],
            }]),
            |_, _| Ok(String::new()),
            &mut approver,
        );
        assert_eq!(r.reply, "done");
    }

    #[test]
    fn executes_read_only_tool_then_finishes() {
        let mut approver = AutoApprove;
        let turns = vec![
            ParsedTurn {
                text: String::new(),
                tool_calls: vec![ToolCall {
                    id: "1".into(),
                    name: "read".into(),
                    args: json!({"path":"x"}),
                }],
            },
            ParsedTurn {
                text: "answer".into(),
                tool_calls: vec![],
            },
        ];
        let r = run_loop(
            RunMode::Plan,
            5,
            vec![],
            |_| false,
            scripted(turns),
            |name, _| Ok(format!("ran {name}")),
            &mut approver,
        );
        assert_eq!(r.reply, "answer");
        assert_eq!(r.tools_used, vec!["read"]);
    }

    #[test]
    fn plan_mode_blocks_mutating_tool() {
        let mut approver = AutoApprove;
        let mut ran = false;
        let turns = vec![
            ParsedTurn {
                text: String::new(),
                tool_calls: vec![ToolCall {
                    id: "1".into(),
                    name: "write".into(),
                    args: json!({}),
                }],
            },
            ParsedTurn {
                text: "fin".into(),
                tool_calls: vec![],
            },
        ];
        let r = run_loop(
            RunMode::Plan,
            5,
            vec![],
            |n| n == "write",
            scripted(turns),
            |_, _| {
                ran = true;
                Ok(String::new())
            },
            &mut approver,
        );
        assert_eq!(r.reply, "fin");
        assert!(!ran, "mutating tool must not run in plan mode");
        assert!(r.tools_used.is_empty());
    }

    #[test]
    fn ask_mode_denied_tool_does_not_run() {
        let mut approver = DenyAll;
        let mut ran = false;
        let turns = vec![
            ParsedTurn {
                text: String::new(),
                tool_calls: vec![ToolCall {
                    id: "1".into(),
                    name: "bash".into(),
                    args: json!({}),
                }],
            },
            ParsedTurn {
                text: "end".into(),
                tool_calls: vec![],
            },
        ];
        let r = run_loop(
            RunMode::Ask,
            5,
            vec![],
            |n| n == "bash",
            scripted(turns),
            |_, _| {
                ran = true;
                Ok(String::new())
            },
            &mut approver,
        );
        assert!(!ran);
        assert_eq!(r.reply, "end");
    }

    #[test]
    fn stops_at_max_iterations() {
        let mut approver = AutoApprove;
        let r = run_loop(
            RunMode::Autopilot,
            2,
            vec![],
            |_| false,
            scripted(vec![ParsedTurn {
                text: String::new(),
                tool_calls: vec![ToolCall {
                    id: "1".into(),
                    name: "read".into(),
                    args: json!({}),
                }],
            }]),
            |_, _| Ok("x".into()),
            &mut approver,
        );
        assert!(r.reply.contains("max iterations"));
    }
}
