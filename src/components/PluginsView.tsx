import type { A2aConnection } from "../types/app";

export default function PluginsView({
  connections,
  onManage,
}: {
  connections: A2aConnection[];
  onManage: () => void;
}) {
  return (
    <div className="panel-view">
      <h2 className="panel-view__title">Plugins</h2>
      <p className="panel-view__subtitle">
        A2A connections expose their skills as callable tools for the agent.
        Manage them in Preferences.
      </p>

      {connections.length === 0 ? (
        <div className="panel-view__empty">
          No plugin connections configured.
        </div>
      ) : (
        <ul className="panel-view__list">
          {connections.map((conn) => (
            <li key={conn.id} className="panel-view__row">
              <div className="panel-view__row-main">
                <span className="panel-view__row-title">
                  {conn.name || conn.endpoint || "Unnamed connection"}
                </span>
                <span className="panel-view__row-meta">
                  {conn.endpoint}
                  {conn.enabled ? "" : " · disabled"}
                </span>
              </div>
              <span
                className={`panel-view__badge${
                  conn.enabled ? " is-on" : ""
                }`}
              >
                {conn.enabled ? "Enabled" : "Off"}
              </span>
            </li>
          ))}
        </ul>
      )}

      <button type="button" className="panel-view__btn" onClick={onManage}>
        Manage in Preferences
      </button>
    </div>
  );
}
