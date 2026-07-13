//! Native agent core: local tools, provider client, A2A bridge, run-mode gating,
//! and the agent loop.

pub mod a2a;
pub mod azure;
pub mod context;
pub mod copilot;
pub mod provider;
pub mod tools;

#[cfg(test)]
mod a2a_e2e_tests;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;

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

// ---------------------------------------------------------------------------
// Shared headless execution: run_once
// ---------------------------------------------------------------------------

/// Reply text produced when a run stops by hitting the iteration cap.
pub const MAX_ITERATIONS_REPLY: &str = "stopped: max iterations reached";

/// Where a run was initiated. Foreground runs stream UI events and prompt for
/// approval; scheduled runs execute headlessly. The origin is available to the
/// shared execution path without changing its output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum RunOrigin {
    Foreground,
    Scheduled { task_id: String },
}

/// The parsed result of a completed run: the model's final answer text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunOutcome {
    pub text: String,
}

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Injected side effects for a single run. The same backend is used regardless
/// of origin so foreground and scheduled runs share identical settings/provider
/// dispatch, tool execution, and approval semantics. Tests supply a deterministic
/// fake; production wires the live provider clients, tool registry, and approval
/// channel. No implementation is bound in `run_once` itself.
pub trait RunBackend: Send + Sync {
    /// Dispatch one turn to the active provider (Copilot / Azure / custom) and
    /// return the parsed turn.
    fn infer<'a>(
        &'a self,
        system: &'a str,
        messages: &'a [provider::Msg],
        tools: &'a [Value],
    ) -> BoxFut<'a, Result<provider::ParsedTurn, String>>;

    /// Execute a resolved tool (local or A2A) and return its result text.
    fn run_tool<'a>(&'a self, name: &'a str, args: &'a Value) -> BoxFut<'a, Result<String, String>>;

    /// Resolve an approval decision for a gated tool call.
    fn approve<'a>(
        &'a self,
        call_id: &'a str,
        name: &'a str,
        args: &'a Value,
    ) -> BoxFut<'a, ApprovalDecision>;
}

/// UI streaming sink. Foreground relays these to Tauri events; headless runs use
/// a no-op sink. Kept separate from [`RunBackend`] so the shared loop stays the
/// sole execution path while presentation varies by origin.
pub trait RunEvents: Send + Sync {
    /// The model's reasoning text that precedes tool calls.
    fn thought(&self, _text: &str) {}
    /// A tool call is about to be gated/executed.
    fn tool_call(&self, _call_id: &str, _tool: &str, _args: &Value) {}
    /// A tool call produced a result.
    fn tool_result(&self, _call_id: &str, _tool: &str, _result: &str) {}
}

/// A [`RunEvents`] sink that discards everything (headless / scheduled runs).
/// Used by the scheduler's headless path (Task 8) and the shared-run tests.
#[allow(dead_code)]
pub struct NullEvents;
impl RunEvents for NullEvents {}

/// The sole shared agent execution path. Runs the provider/tool loop against the
/// injected [`RunBackend`], streaming progress to [`RunEvents`]. Foreground and
/// scheduled origins call this identically; `origin` is available for the caller
/// and does not alter the produced [`RunOutcome`]. Returns `Err` if a provider
/// dispatch fails (matching the foreground error path).
#[allow(clippy::too_many_arguments)]
pub async fn run_once<B, E, A, M>(
    origin: RunOrigin,
    mode: RunMode,
    system: String,
    mut messages: Vec<provider::Msg>,
    tool_defs: Vec<Value>,
    max_iterations: usize,
    is_a2a: A,
    is_mutating: M,
    backend: &B,
    events: &E,
) -> Result<RunOutcome, String>
where
    B: RunBackend,
    E: RunEvents,
    A: Fn(&str) -> bool,
    M: Fn(&str) -> bool,
{
    // The origin travels with the run but must not influence the output; both
    // foreground and scheduled paths dispatch and parse identically.
    let _ = &origin;
    let max = max_iterations.max(1);
    let mut session_allow: HashSet<String> = HashSet::new();
    let mut counter: u64 = 0;

    for _ in 0..max {
        let turn = backend.infer(&system, &messages, &tool_defs).await?;
        if turn.tool_calls.is_empty() {
            return Ok(RunOutcome { text: turn.text });
        }
        if !turn.text.trim().is_empty() {
            events.thought(&turn.text);
        }
        for call in &turn.tool_calls {
            counter += 1;
            let call_id = format!("call-{counter}");
            // A2A delegation mutates remote state, so it is gated exactly like a
            // local mutating tool: BLOCK in Plan, APPROVE in Ask, auto in
            // Autopilot. Treating it as read-only would let scheduled/headless
            // runs invoke remote skills without the safety gate.
            let mutating = is_a2a(&call.name) || is_mutating(&call.name);
            events.tool_call(&call_id, &call.name, &call.args);

            let decision = match gate(mode, mutating) {
                Gate::Auto => ApprovalDecision::Approve,
                Gate::Block => {
                    messages.push(provider::Msg {
                        role: "user".into(),
                        content: format!("[tool {} blocked in plan mode]", call.name),
                    });
                    continue;
                }
                Gate::Approve => {
                    if session_allow.contains(&call.name) {
                        ApprovalDecision::Approve
                    } else {
                        backend.approve(&call_id, &call.name, &call.args).await
                    }
                }
            };

            let result = match decision {
                ApprovalDecision::Deny => format!("[tool {} denied by user]", call.name),
                d => {
                    if d == ApprovalDecision::AllowSession {
                        session_allow.insert(call.name.clone());
                    }
                    backend
                        .run_tool(&call.name, &call.args)
                        .await
                        .unwrap_or_else(|e| format!("error: {e}"))
                }
            };
            events.tool_result(&call_id, &call.name, &result);
            messages.push(provider::Msg {
                role: "user".into(),
                content: format!("[tool {} result]\n{result}", call.name),
            });
        }
    }
    Ok(RunOutcome {
        text: MAX_ITERATIONS_REPLY.into(),
    })
}

#[cfg(test)]
mod run_once_tests {
    use super::provider::{Msg, ParsedTurn, ToolCall};
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    /// Deterministic backend: scripts provider turns, records the number of
    /// infer/tool dispatches, and auto-approves. No sockets or live network.
    struct FakeBackend {
        turns: Vec<ParsedTurn>,
        infer_calls: Mutex<usize>,
        tool_calls: Mutex<Vec<String>>,
        approvals: Mutex<usize>,
    }
    impl FakeBackend {
        fn new(turns: Vec<ParsedTurn>) -> Self {
            Self {
                turns,
                infer_calls: Mutex::new(0),
                tool_calls: Mutex::new(Vec::new()),
                approvals: Mutex::new(0),
            }
        }
    }
    impl RunBackend for FakeBackend {
        fn infer<'a>(
            &'a self,
            _system: &'a str,
            _messages: &'a [Msg],
            _tools: &'a [Value],
        ) -> BoxFut<'a, Result<ParsedTurn, String>> {
            Box::pin(async move {
                let mut i = self.infer_calls.lock().unwrap();
                let turn = self.turns[(*i).min(self.turns.len() - 1)].clone();
                *i += 1;
                Ok(turn)
            })
        }
        fn run_tool<'a>(
            &'a self,
            name: &'a str,
            _args: &'a Value,
        ) -> BoxFut<'a, Result<String, String>> {
            Box::pin(async move {
                self.tool_calls.lock().unwrap().push(name.to_string());
                Ok(format!("ran {name}"))
            })
        }
        fn approve<'a>(
            &'a self,
            _call_id: &'a str,
            _name: &'a str,
            _args: &'a Value,
        ) -> BoxFut<'a, ApprovalDecision> {
            Box::pin(async move {
                *self.approvals.lock().unwrap() += 1;
                ApprovalDecision::Approve
            })
        }
    }

    fn text_turn(t: &str) -> ParsedTurn {
        ParsedTurn {
            text: t.into(),
            tool_calls: vec![],
        }
    }

    fn seed() -> Vec<Msg> {
        vec![Msg {
            role: "user".into(),
            content: "hello".into(),
        }]
    }

    #[tokio::test]
    async fn foreground_and_scheduled_share_dispatch_and_response() {
        // Same scripted provider, same inputs, only the origin differs.
        let make = || FakeBackend::new(vec![text_turn("the answer")]);

        let fg_backend = make();
        let fg = run_once(
            RunOrigin::Foreground,
            RunMode::Ask,
            "sys".into(),
            seed(),
            vec![],
            8,
            |_| false,
            |_| false,
            &fg_backend,
            &NullEvents,
        )
        .await
        .unwrap();

        let sc_backend = make();
        let sc = run_once(
            RunOrigin::Scheduled {
                task_id: "job-1".into(),
            },
            RunMode::Ask,
            "sys".into(),
            seed(),
            vec![],
            8,
            |_| false,
            |_| false,
            &sc_backend,
            &NullEvents,
        )
        .await
        .unwrap();

        // Identical parsed response regardless of origin.
        assert_eq!(fg, sc);
        assert_eq!(fg.text, "the answer");
        // Identical provider dispatch count regardless of origin.
        assert_eq!(
            *fg_backend.infer_calls.lock().unwrap(),
            *sc_backend.infer_calls.lock().unwrap()
        );
        assert_eq!(*fg_backend.infer_calls.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn origin_is_available_without_changing_output() {
        // A scheduled origin carrying a task id yields the same text as foreground.
        let backend = FakeBackend::new(vec![text_turn("done")]);
        let out = run_once(
            RunOrigin::Scheduled {
                task_id: "abc".into(),
            },
            RunMode::Autopilot,
            "sys".into(),
            seed(),
            vec![],
            8,
            |_| false,
            |_| false,
            &backend,
            &NullEvents,
        )
        .await
        .unwrap();
        assert_eq!(out.text, "done");
    }

    #[tokio::test]
    async fn tool_loop_executes_then_returns_final_text() {
        let turns = vec![
            ParsedTurn {
                text: "let me look".into(),
                tool_calls: vec![ToolCall {
                    id: "1".into(),
                    name: "read".into(),
                    args: json!({"path": "x"}),
                }],
            },
            text_turn("final"),
        ];
        let backend = FakeBackend::new(turns);
        let out = run_once(
            RunOrigin::Foreground,
            RunMode::Ask,
            "sys".into(),
            seed(),
            vec![],
            8,
            |_| false,
            |_| false, // read is non-mutating -> auto
            &backend,
            &NullEvents,
        )
        .await
        .unwrap();
        assert_eq!(out.text, "final");
        assert_eq!(*backend.tool_calls.lock().unwrap(), vec!["read"]);
        assert_eq!(*backend.infer_calls.lock().unwrap(), 2);
    }

    #[tokio::test]
    async fn mutating_tool_is_gated_through_approval_in_both_origins() {
        let turns = vec![
            ParsedTurn {
                text: String::new(),
                tool_calls: vec![ToolCall {
                    id: "1".into(),
                    name: "write".into(),
                    args: json!({}),
                }],
            },
            text_turn("ok"),
        ];
        for origin in [
            RunOrigin::Foreground,
            RunOrigin::Scheduled {
                task_id: "j".into(),
            },
        ] {
            let backend = FakeBackend::new(turns.clone());
            let out = run_once(
                origin,
                RunMode::Ask,
                "sys".into(),
                seed(),
                vec![],
                8,
                |_| false,
                |n| n == "write",
                &backend,
                &NullEvents,
            )
            .await
            .unwrap();
            assert_eq!(out.text, "ok");
            assert_eq!(*backend.approvals.lock().unwrap(), 1);
            assert_eq!(*backend.tool_calls.lock().unwrap(), vec!["write"]);
        }
    }

    #[tokio::test]
    async fn plan_mode_blocks_a2a_delegation_in_both_origins() {
        // A2A skills mutate remote state, so Plan mode must BLOCK them (never
        // auto-run) exactly like a local mutating tool. Reference `gate` docs.
        let turns = vec![
            ParsedTurn {
                text: String::new(),
                tool_calls: vec![ToolCall {
                    id: "1".into(),
                    name: "delegate_search".into(),
                    args: json!({"task": "x"}),
                }],
            },
            text_turn("fin"),
        ];
        for origin in [
            RunOrigin::Foreground,
            RunOrigin::Scheduled {
                task_id: "j".into(),
            },
        ] {
            let backend = FakeBackend::new(turns.clone());
            let out = run_once(
                origin,
                RunMode::Plan,
                "sys".into(),
                seed(),
                vec![],
                8,
                |n| n == "delegate_search", // is_a2a
                |_| false,                   // not a local mutating tool
                &backend,
                &NullEvents,
            )
            .await
            .unwrap();
            assert_eq!(out.text, "fin");
            // Blocked: never approved, never executed.
            assert_eq!(*backend.approvals.lock().unwrap(), 0);
            assert!(backend.tool_calls.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn ask_mode_requires_approval_for_a2a_in_both_origins() {
        // Ask mode must gate A2A delegation through approval before running.
        let turns = vec![
            ParsedTurn {
                text: String::new(),
                tool_calls: vec![ToolCall {
                    id: "1".into(),
                    name: "delegate_search".into(),
                    args: json!({"task": "x"}),
                }],
            },
            text_turn("done"),
        ];
        for origin in [
            RunOrigin::Foreground,
            RunOrigin::Scheduled {
                task_id: "j".into(),
            },
        ] {
            let backend = FakeBackend::new(turns.clone());
            let out = run_once(
                origin,
                RunMode::Ask,
                "sys".into(),
                seed(),
                vec![],
                8,
                |n| n == "delegate_search", // is_a2a
                |_| false,                   // not a local mutating tool
                &backend,
                &NullEvents,
            )
            .await
            .unwrap();
            assert_eq!(out.text, "done");
            // Approval requested (FakeBackend auto-approves), then executed.
            assert_eq!(*backend.approvals.lock().unwrap(), 1);
            assert_eq!(*backend.tool_calls.lock().unwrap(), vec!["delegate_search"]);
        }
    }

    #[tokio::test]
    async fn ask_mode_denied_a2a_does_not_execute() {
        // When the approver denies, the A2A skill must not run.
        struct DenyBackend {
            turns: Vec<ParsedTurn>,
            infer_calls: Mutex<usize>,
            tool_calls: Mutex<Vec<String>>,
        }
        impl RunBackend for DenyBackend {
            fn infer<'a>(
                &'a self,
                _s: &'a str,
                _m: &'a [Msg],
                _t: &'a [Value],
            ) -> BoxFut<'a, Result<ParsedTurn, String>> {
                Box::pin(async move {
                    let mut i = self.infer_calls.lock().unwrap();
                    let t = self.turns[(*i).min(self.turns.len() - 1)].clone();
                    *i += 1;
                    Ok(t)
                })
            }
            fn run_tool<'a>(
                &'a self,
                n: &'a str,
                _a: &'a Value,
            ) -> BoxFut<'a, Result<String, String>> {
                Box::pin(async move {
                    self.tool_calls.lock().unwrap().push(n.to_string());
                    Ok("ran".into())
                })
            }
            fn approve<'a>(
                &'a self,
                _c: &'a str,
                _n: &'a str,
                _a: &'a Value,
            ) -> BoxFut<'a, ApprovalDecision> {
                Box::pin(async move { ApprovalDecision::Deny })
            }
        }
        let backend = DenyBackend {
            turns: vec![
                ParsedTurn {
                    text: String::new(),
                    tool_calls: vec![ToolCall {
                        id: "1".into(),
                        name: "delegate_search".into(),
                        args: json!({}),
                    }],
                },
                text_turn("end"),
            ],
            infer_calls: Mutex::new(0),
            tool_calls: Mutex::new(Vec::new()),
        };
        let out = run_once(
            RunOrigin::Scheduled {
                task_id: "j".into(),
            },
            RunMode::Ask,
            "sys".into(),
            seed(),
            vec![],
            8,
            |n| n == "delegate_search",
            |_| false,
            &backend,
            &NullEvents,
        )
        .await
        .unwrap();
        assert_eq!(out.text, "end");
        assert!(backend.tool_calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn stops_at_max_iterations_with_cap_reply() {
        // A provider that always requests a tool must terminate at the cap.
        let backend = FakeBackend::new(vec![ParsedTurn {
            text: String::new(),
            tool_calls: vec![ToolCall {
                id: "1".into(),
                name: "read".into(),
                args: json!({}),
            }],
        }]);
        let out = run_once(
            RunOrigin::Foreground,
            RunMode::Autopilot,
            "sys".into(),
            seed(),
            vec![],
            2,
            |_| false,
            |_| false,
            &backend,
            &NullEvents,
        )
        .await
        .unwrap();
        assert_eq!(out.text, MAX_ITERATIONS_REPLY);
        // Exactly `max` provider dispatches, no more.
        assert_eq!(*backend.infer_calls.lock().unwrap(), 2);
    }

    #[tokio::test]
    async fn event_sink_receives_ordered_thought_call_result() {
        // The sink must observe thought -> tool_call -> tool_result in order.
        struct RecEvents(Mutex<Vec<String>>);
        impl RunEvents for RecEvents {
            fn thought(&self, text: &str) {
                self.0.lock().unwrap().push(format!("thought:{text}"));
            }
            fn tool_call(&self, _id: &str, tool: &str, _a: &Value) {
                self.0.lock().unwrap().push(format!("call:{tool}"));
            }
            fn tool_result(&self, _id: &str, tool: &str, result: &str) {
                self.0.lock().unwrap().push(format!("result:{tool}={result}"));
            }
        }
        let turns = vec![
            ParsedTurn {
                text: "thinking".into(),
                tool_calls: vec![ToolCall {
                    id: "1".into(),
                    name: "read".into(),
                    args: json!({}),
                }],
            },
            text_turn("final"),
        ];
        let backend = FakeBackend::new(turns);
        let events = RecEvents(Mutex::new(Vec::new()));
        let out = run_once(
            RunOrigin::Foreground,
            RunMode::Ask,
            "sys".into(),
            seed(),
            vec![],
            8,
            |_| false,
            |_| false,
            &backend,
            &events,
        )
        .await
        .unwrap();
        assert_eq!(out.text, "final");
        assert_eq!(
            *events.0.lock().unwrap(),
            vec![
                "thought:thinking".to_string(),
                "call:read".to_string(),
                "result:read=ran read".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn provider_error_propagates() {
        struct ErrBackend;
        impl RunBackend for ErrBackend {
            fn infer<'a>(
                &'a self,
                _s: &'a str,
                _m: &'a [Msg],
                _t: &'a [Value],
            ) -> BoxFut<'a, Result<ParsedTurn, String>> {
                Box::pin(async move { Err("provider HTTP 500".to_string()) })
            }
            fn run_tool<'a>(
                &'a self,
                _n: &'a str,
                _a: &'a Value,
            ) -> BoxFut<'a, Result<String, String>> {
                Box::pin(async move { Ok(String::new()) })
            }
            fn approve<'a>(
                &'a self,
                _c: &'a str,
                _n: &'a str,
                _a: &'a Value,
            ) -> BoxFut<'a, ApprovalDecision> {
                Box::pin(async move { ApprovalDecision::Approve })
            }
        }
        let err = run_once(
            RunOrigin::Foreground,
            RunMode::Ask,
            "sys".into(),
            seed(),
            vec![],
            8,
            |_| false,
            |_| false,
            &ErrBackend,
            &NullEvents,
        )
        .await
        .unwrap_err();
        assert_eq!(err, "provider HTTP 500");
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
