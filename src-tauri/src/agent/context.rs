//! Context engineering: assemble the model's working memory each turn within a
//! fixed token budget, following the Harness Engineering Guide model.
//!
//! Two responsibilities:
//!  * `ContextAssembler` — prioritized packing of the *system* block (system
//!    prompt, memory summary, injected files) against a token budget, with a
//!    response headroom reserve.
//!  * `pack_history` — a sliding window over conversation messages: keep the
//!    most recent turns verbatim and roll everything older into a compact
//!    running summary so long conversations stay within budget.

use crate::agent::provider::Msg;

/// Rough token estimate. Real tokenizers vary by model; ~4 chars/token is a
/// safe, dependency-free approximation for budgeting (slightly conservative).
pub fn estimate_tokens(text: &str) -> usize {
    // Round up so short strings still cost at least 1 token.
    text.chars().count().div_ceil(4)
}

/// A named, prioritized section of the system context block.
/// Lower `priority` = more important (packed first, truncated not dropped).
#[derive(Debug, Clone)]
struct Section {
    priority: u8,
    name: String,
    content: String,
}

/// Packs prioritized sections into a single system string within a token budget.
pub struct ContextAssembler {
    sections: Vec<Section>,
    max_tokens: usize,
}

impl ContextAssembler {
    /// `max_tokens` is the budget for the system block only (history is packed
    /// separately by `pack_history`).
    pub fn new(max_tokens: usize) -> Self {
        Self {
            sections: Vec::new(),
            max_tokens,
        }
    }

    /// Add a section. Empty content is ignored. `name` labels the block in the
    /// assembled output so the model can tell sections apart.
    pub fn add(&mut self, priority: u8, name: &str, content: &str) -> &mut Self {
        if !content.trim().is_empty() {
            self.sections.push(Section {
                priority,
                name: name.to_string(),
                content: content.trim().to_string(),
            });
        }
        self
    }

    /// Assemble the system block. Sections are sorted by priority; each is
    /// added whole while it fits. Critical sections (priority <= 1) are
    /// truncated to fit rather than dropped; lower-priority sections that don't
    /// fit are excluded entirely.
    pub fn build(&self) -> String {
        let mut sorted = self.sections.clone();
        sorted.sort_by_key(|s| s.priority);

        let mut out: Vec<String> = Vec::new();
        let mut used = 0usize;
        for s in &sorted {
            let block = format!("[{}]\n{}", s.name, s.content);
            let cost = estimate_tokens(&block);
            if used + cost <= self.max_tokens {
                used += cost;
                out.push(block);
            } else if s.priority <= 1 {
                // Truncate a critical section to whatever budget remains.
                let remaining = self.max_tokens.saturating_sub(used);
                if remaining > 8 {
                    let keep_chars = remaining * 4;
                    let truncated: String = s.content.chars().take(keep_chars).collect();
                    let block = format!("[{}]\n{}…", s.name, truncated);
                    used += estimate_tokens(&block);
                    out.push(block);
                }
                break; // no room for anything after a truncated critical block
            }
            // else: silently skip lower-priority section that doesn't fit
        }
        out.join("\n\n")
    }
}

/// Sliding-window history packing. Keeps the last `keep_recent` messages
/// verbatim; if older messages exist and the total exceeds `max_tokens`, the
/// older ones are collapsed into a single summary message prepended to the
/// window. Returns the messages to send to the model, in order.
pub fn pack_history(messages: &[Msg], max_tokens: usize, keep_recent: usize) -> Vec<Msg> {
    let total: usize = messages
        .iter()
        .map(|m| estimate_tokens(&m.content))
        .sum();

    // Fast path: everything fits, nothing to compact.
    if total <= max_tokens || messages.len() <= keep_recent {
        return messages.to_vec();
    }

    let split = messages.len().saturating_sub(keep_recent);
    let (older, recent) = messages.split_at(split);
    let summary = summarize(older);

    let mut out = Vec::with_capacity(recent.len() + 1);
    out.push(Msg {
        role: "user".into(),
        content: format!("[earlier conversation summary]\n{summary}"),
    });
    out.extend(recent.iter().cloned());
    out
}

/// Collapse older messages into a compact, lossy running summary. This is a
/// deterministic extractive summary (no model call): it lists each earlier turn
/// as a trimmed one-liner so key facts and file paths survive.
fn summarize(msgs: &[Msg]) -> String {
    let mut lines = Vec::new();
    for m in msgs {
        let one_line = m
            .content
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let clipped: String = one_line.chars().take(200).collect();
        if !clipped.is_empty() {
            lines.push(format!("- {}: {clipped}", m.role));
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str) -> Msg {
        Msg {
            role: role.into(),
            content: content.into(),
        }
    }

    #[test]
    fn estimate_is_roughly_quarter_chars() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
    }

    #[test]
    fn assembler_orders_by_priority_and_labels() {
        let mut a = ContextAssembler::new(1000);
        a.add(2, "memory", "remembered stuff")
            .add(0, "system", "you are an agent");
        let out = a.build();
        // system (priority 0) comes before memory (priority 2)
        assert!(out.find("[system]").unwrap() < out.find("[memory]").unwrap());
        assert!(out.contains("you are an agent"));
        assert!(out.contains("remembered stuff"));
    }

    #[test]
    fn assembler_drops_low_priority_when_over_budget() {
        let mut a = ContextAssembler::new(10); // ~40 chars
        a.add(0, "system", "critical instructions that matter")
            .add(5, "files", &"x".repeat(400));
        let out = a.build();
        assert!(out.contains("[system]"));
        assert!(!out.contains("[files]")); // low priority excluded
    }

    #[test]
    fn assembler_ignores_empty_sections() {
        let mut a = ContextAssembler::new(1000);
        a.add(0, "system", "hi").add(1, "memory", "   ");
        let out = a.build();
        assert!(out.contains("[system]"));
        assert!(!out.contains("[memory]"));
    }

    #[test]
    fn pack_history_keeps_all_when_small() {
        let msgs = vec![msg("user", "hi"), msg("assistant", "hello")];
        let out = pack_history(&msgs, 1000, 6);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn pack_history_summarizes_older_turns() {
        let mut msgs = Vec::new();
        for i in 0..10 {
            msgs.push(msg("user", &format!("question number {i} with some length padding")));
            msgs.push(msg("assistant", &format!("answer number {i} with some length padding")));
        }
        // Tiny budget forces compaction; keep last 4 verbatim.
        let out = pack_history(&msgs, 20, 4);
        assert!(out.len() < msgs.len());
        assert_eq!(out[0].role, "user");
        assert!(out[0].content.contains("earlier conversation summary"));
        // The most recent message survives verbatim.
        assert_eq!(out.last().unwrap().content, msgs.last().unwrap().content);
    }
}
