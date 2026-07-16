import { useEffect, useState } from "react";
import { invoke } from "../lib/runtime";
import type { AppSettings, A2aConnection } from "../types/app";
import type { AgentCard, AgentCardSkill } from "../lib/a2aClient";

interface Props {
  onClose: () => void;
}

/** A skill entry shown in the panel. `source` explains where it came from so
 * users can tell built-in local skills apart from those delegated to A2A hubs. */
interface SkillEntry {
  id: string;
  name: string;
  description?: string;
  source: string;
  disabled?: boolean;
  tags?: string[];
}

/** Shape returned by the sidecar's `list_skills` endpoint. Kept permissive so
 * newer/older backends don't break the panel. */
interface LocalSkill {
  name?: string;
  id?: string;
  description?: string;
  version?: string;
  path?: string;
  disabled?: boolean;
  tags?: string[];
}

async function loadLocalSkills(): Promise<SkillEntry[]> {
  try {
    const items = await invoke<LocalSkill[]>("list_skills");
    if (!Array.isArray(items)) return [];
    return items.map((s, i) => ({
      id: `local:${s.name ?? s.id ?? i}`,
      name: s.name ?? s.id ?? `skill-${i}`,
      description: s.description,
      source: "Local",
      disabled: !!s.disabled,
      tags: s.tags,
    }));
  } catch {
    return [];
  }
}

async function loadA2aSkills(
  connections: A2aConnection[],
): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];
  await Promise.all(
    connections
      .filter((c) => c.enabled && c.endpoint.trim())
      .map(async (conn) => {
        try {
          const card = await invoke<AgentCard>("a2a_discover_card", {
            connectionId: conn.id,
            endpoint: conn.endpoint,
            token: conn.token,
          });
          for (const skill of card?.skills ?? []) {
            const s = skill as AgentCardSkill;
            const sid = s.id ?? s.name ?? "";
            const disabled = sid ? conn.disabled_skills?.includes(sid) : false;
            entries.push({
              id: `a2a:${conn.id}:${sid || entries.length}`,
              name: s.name ?? (sid || "(unnamed)"),
              description: s.description,
              source: `A2A · ${conn.name || conn.endpoint}`,
              disabled: !!disabled,
              tags: s.tags,
            });
          }
        } catch {
          entries.push({
            id: `a2a:${conn.id}:error`,
            name: conn.name || conn.endpoint,
            description: "Discovery failed for this A2A connection.",
            source: `A2A · ${conn.name || conn.endpoint}`,
            disabled: true,
          });
        }
      }),
  );
  return entries;
}

export default function SkillsPanel({ onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [skills, setSkills] = useState<SkillEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const settings = await invoke<AppSettings>("get_settings").catch(
        () => null,
      );
      const connections = settings?.a2a_connections ?? [];
      const [local, remote] = await Promise.all([
        loadLocalSkills(),
        loadA2aSkills(connections),
      ]);
      if (!cancelled) {
        setSkills([...local, ...remote]);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      className="help-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="help-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Available skills"
      >
        <div className="help-panel__header">
          <h2 className="help-panel__title">
            Skills{skills.length ? ` (${skills.length})` : ""}
          </h2>
          <button
            type="button"
            className="help-panel__close"
            aria-label="Close skills"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        {loading ? (
          <div style={{ color: "var(--sub)", fontSize: 13 }}>
            Loading skills…
          </div>
        ) : skills.length === 0 ? (
          <div style={{ color: "var(--sub)", fontSize: 13 }}>
            No skills available. Add A2A connections in Settings or install
            local skills.
          </div>
        ) : (
          <ul className="help-panel__list" role="list">
            {skills.map((s) => (
              <li key={s.id}>
                <div
                  className="help-panel__row"
                  style={{ opacity: s.disabled ? 0.55 : 1 }}
                >
                  <code className="help-panel__cmd">
                    {s.name}
                    {s.disabled ? " (disabled)" : ""}
                  </code>
                  <span className="help-panel__desc">
                    {s.source}
                    {s.description ? ` — ${s.description}` : ""}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
