import { useState, useEffect } from "react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  Legend,
} from "recharts";
import { SAMPLE_DATA } from "../data/sample-data.js";
import { formatTokens } from "../tokens.js";
import {
  COLORS,
  SANS,
  MONO,
  MOTION,
  TONES,
  taskTone,
  riseStyle,
  usePrefersReducedMotion,
} from "../theme.js";

function useTelemData(externalData) {
  const [data, setData] = useState(null);
  const [source, setSource] = useState("loading");

  useEffect(() => {
    // If external data is provided (from RunPicker or parent), use it directly
    if (externalData) {
      setData(externalData.data);
      setSource(externalData.source);
      return;
    }

    // Default: fetch local data file, fall back to sample
    fetch(import.meta.env.BASE_URL + "data/latest.json")
      .then((r) => {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      })
      .then((json) => {
        if (json?.weekly?.length > 0) {
          setData(json);
          setSource("live");
        } else {
          setData(SAMPLE_DATA);
          setSource("sample");
        }
      })
      .catch(() => {
        setData(SAMPLE_DATA);
        setSource("sample");
      });
  }, [externalData]);

  return { data, source };
}

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

// Axon status for a metric value: good = success, warn = attention (amber),
// usage = tokens (amber), bad = failure (magenta). Anything else is neutral.
function metricColor(status) {
  if (status === "good" || status === "green") return TONES.success.color;
  if (status === "warn" || status === "amber" || status === "usage") return TONES.progress.color;
  if (status === "bad" || status === "red") return TONES.failure.color;
  return COLORS.textMuted;
}

function MetricCard({ label, value, subtext, trend, status, index = 0 }) {
  const statusColor = metricColor(status);

  return (
    <div
      className="axon-panel axon-rise"
      style={{
        ...riseStyle(index),
        borderRadius: 12,
        padding: "20px 24px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <span
        style={{
          fontSize: 12,
          color: COLORS.textDim,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </span>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span
          style={{
            fontSize: 32,
            fontWeight: 700,
            color: statusColor,
            fontFamily: MONO,
          }}
        >
          {value}
        </span>
        {trend && (
          // A direction is not a state: trends stay neutral, never green or magenta.
          <span
            style={{
              fontSize: 12,
              color: TONES.neutral.color,
              background: TONES.neutral.dim,
              padding: "2px 8px",
              borderRadius: 4,
              fontFamily: MONO,
            }}
          >
            {trend}
          </span>
        )}
      </div>
      {subtext && (
        <span style={{ fontSize: 12, color: COLORS.textDim }}>{subtext}</span>
      )}
    </div>
  );
}

function SectionHeader({ children, subtitle }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <h2
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: COLORS.text,
          margin: 0,
          letterSpacing: "-0.01em",
        }}
      >
        {children}
      </h2>
      {subtitle && (
        <p style={{ fontSize: 12, color: COLORS.textDim, margin: "4px 0 0" }}>
          {subtitle}
        </p>
      )}
    </div>
  );
}

function CustomTooltip({ active, payload, label, formatter }) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="axon-panel"
      style={{
        borderRadius: 8,
        padding: "10px 14px",
        fontSize: 12,
        fontFamily: MONO,
      }}
    >
      <div style={{ color: COLORS.textMuted, marginBottom: 6 }}>{label}</div>
      {payload.map((p, i) => (
        <div
          key={i}
          style={{
            color: p.color,
            display: "flex",
            gap: 8,
            justifyContent: "space-between",
          }}
        >
          <span>{p.name}</span>
          <span style={{ fontWeight: 600 }}>
            {formatter ? formatter(p.value) : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

const isCount = (v) => Number.isFinite(v) && v >= 0;

// A record's tokens: all input (fresh, cache reads, cache writes) plus output.
// Reads `tokens` as a count or a TokenBreakdown { freshInput, cacheRead,
// cacheWrite, output }, else `inputTokens` + `outputTokens`. Null when the
// record carries no token data.
function tokensOf(record) {
  if (!record) return null;
  const t = record.tokens;
  if (isCount(t)) return t;
  if (t && typeof t === "object") {
    const parts = [t.freshInput, t.cacheRead, t.cacheWrite, t.output].filter(isCount);
    return parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : null;
  }
  if (isCount(record.inputTokens) || isCount(record.outputTokens)) {
    return (isCount(record.inputTokens) ? record.inputTokens : 0) + (isCount(record.outputTokens) ? record.outputTokens : 0);
  }
  return null;
}

// The input/output split behind tokensOf, as the live dashboard words it, or
// null when the record has only a total.
function tokenSplit(record) {
  if (!record) return null;
  const t = record.tokens;
  const n = (v) => (isCount(v) ? v : 0);
  if (t && typeof t === "object") {
    return `in ${formatTokens(n(t.freshInput))} · cached ${formatTokens(n(t.cacheRead) + n(t.cacheWrite))} · out ${formatTokens(n(t.output))}`;
  }
  if (isCount(record.inputTokens) || isCount(record.outputTokens)) {
    return `in ${formatTokens(n(record.inputTokens))} · out ${formatTokens(n(record.outputTokens))}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Event tone — Axon status semantics for an event type
// ---------------------------------------------------------------------------

function eventTone(type) {
  if (/fail|error|reject|abort|exceeded|wedged/.test(type)) return TONES.failure;
  if (type.includes("token")) return TONES.progress;
  if (/complete|approved|merged/.test(type)) return TONES.success;
  if (/start|progress/.test(type)) return TONES.active;
  return TONES.neutral;
}

// Visual treatment for the role chip. `planning_ahead` is the speculative
// sub-decomposition path — the worker is generating a plan but NOT editing
// the repo. `editing` (default when role is unset) means the worker is
// actively touching files. Distinct tone + glyph so a single-card screenshot
// is unambiguous about which kind of in-progress work is happening: editing
// is active (cyan); planning ahead is not yet active, so it stays neutral.
function roleDisplay(role) {
  switch (role) {
    case "planning_ahead":
      return { label: "planning ahead", glyph: "🔭", tone: TONES.neutral };
    case "editing":
    default:
      return { label: "editing", glyph: "✏️", tone: TONES.active };
  }
}

function BackendBadge({ backend }) {
  if (!backend) return null;
  const isCC = backend === "claude-code";
  return (
    <span style={{
      display: "inline-block",
      padding: "1px 6px",
      borderRadius: 4,
      fontSize: 11,
      fontFamily: MONO,
      fontWeight: 600,
      backgroundColor: TONES.neutral.dim,
      color: TONES.neutral.color,
      marginLeft: 6,
    }}>
      {isCC ? "CC" : "API"}
    </span>
  );
}

function DrillDownLink({ label, view, setActiveView }) {
  return (
    <button
      onClick={() => setActiveView(view)}
      className="axon-btn axon-btn-secondary"
      style={{
        borderRadius: 10,
        padding: "12px 20px",
        fontSize: 13,
        flex: 1,
        justifyContent: "flex-start",
      }}
    >
      {label} →
    </button>
  );
}

// ---------------------------------------------------------------------------
// EventRow + EventLog — chronological event stream
// ---------------------------------------------------------------------------

function EventRow({ event, expanded, onToggle }) {
  const time = new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const typeColor = eventTone(event.type).color;
  const eventTokens = tokensOf(event);

  return (
    <div
      onClick={onToggle}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
      style={{
        padding: "8px 12px",
        borderBottom: `1px solid ${COLORS.border}`,
        cursor: "pointer",
        background: expanded ? COLORS.surfaceHover : "transparent",
        transition: `background ${MOTION.fast} ${MOTION.standard}`,
      }}
      onMouseEnter={(e) => { if (!expanded) e.currentTarget.style.background = COLORS.surfaceHover; }}
      onMouseLeave={(e) => { if (!expanded) e.currentTarget.style.background = "transparent"; }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
        <span style={{ color: COLORS.textDim, minWidth: 70, fontFamily: MONO }}>{time}</span>
        <span style={{ color: typeColor, minWidth: 150, fontWeight: 500, fontFamily: MONO }}>{event.type}</span>
        <BackendBadge backend={event.backend} />
        {event.role && (
          <span style={{
            padding: "1px 5px",
            borderRadius: 3,
            fontSize: 10,
            fontWeight: 600,
            backgroundColor: TONES.neutral.dim,
            color: TONES.neutral.color,
          }}>
            {event.role}
          </span>
        )}
        <span style={{ color: COLORS.text, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {event.summary}
        </span>
        {eventTokens != null && eventTokens > 0 && (
          <span style={{ color: TONES.progress.color, fontFamily: MONO, fontSize: 11 }}>
            {formatTokens(eventTokens)} tokens
          </span>
        )}
      </div>
      {expanded && event.details && (
        <pre style={{
          marginTop: 8,
          padding: 8,
          background: COLORS.bg,
          borderRadius: 4,
          fontSize: 11,
          fontFamily: MONO,
          color: COLORS.textMuted,
          overflow: "auto",
          maxHeight: 200,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}>
          {JSON.stringify(event.details, null, 2)}
        </pre>
      )}
    </div>
  );
}

function EventLog({ events, expandedEvents, onToggleEvent }) {
  const [filter, setFilter] = useState("all");

  const allEvents = events ?? [];
  const filtered = allEvents
    .map((evt, originalIndex) => ({ ...evt, _idx: originalIndex }))
    .filter((evt) => {
      if (filter === "all") return true;
      if (filter === "swarm") return evt.type.startsWith("session:") || evt.type.startsWith("intent:");
      if (filter === "oversight") return evt.type.startsWith("oversight:");
      if (filter === "orchestration") return evt.type.startsWith("orchestration:") || evt.type.startsWith("task:") || evt.type.startsWith("goal:");
      if (filter === "tokens") return evt.type.includes("token");
      return true;
    });

  const filters = ["all", "swarm", "oversight", "orchestration", "tokens"];

  return (
    <div style={{ marginBottom: 24 }}>
      <SectionHeader subtitle={`${filtered.length} events`}>
        Event Log
      </SectionHeader>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {filters.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            style={{
              padding: "4px 12px",
              borderRadius: 4,
              border: `1px solid ${filter === f ? COLORS.accent : COLORS.border}`,
              background: filter === f ? COLORS.accentDim : "transparent",
              color: filter === f ? COLORS.accent : COLORS.textMuted,
              fontFamily: SANS,
              fontSize: 11,
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {f}
          </button>
        ))}
      </div>
      <div style={{
        maxHeight: 450,
        overflowY: "auto",
        border: `1px solid ${COLORS.border}`,
        borderRadius: 8,
        background: COLORS.surface,
      }}>
        {filtered.slice(0, 50).map((evt) => (
          <EventRow
            key={evt._idx}
            event={evt}
            expanded={expandedEvents.has(evt._idx)}
            onToggle={() => onToggleEvent(evt._idx)}
          />
        ))}
        {filtered.length === 0 && (
          <div style={{ padding: 24, textAlign: "center", color: COLORS.textDim, fontSize: 12 }}>
            No events to display
          </div>
        )}
        {filtered.length > 50 && (
          <div style={{ padding: 12, textAlign: "center", color: COLORS.textDim, fontSize: 11 }}>
            Showing <span style={{ fontFamily: MONO }}>50</span> of <span style={{ fontFamily: MONO }}>{filtered.length}</span> events
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RoleChip — speculative-vs-active indicator on in-progress tasks
// ---------------------------------------------------------------------------

function RoleChip({ role }) {
  const display = roleDisplay(role);
  return (
    <span
      title={role === "planning_ahead"
        ? "Speculative sub-decomposition: this worker is drafting a plan, not editing files."
        : "Active implementation: this worker is editing files in a worktree."}
      style={{
        fontSize: 10,
        fontWeight: 600,
        color: display.tone.color,
        background: display.tone.dim,
        padding: "2px 8px",
        borderRadius: 10,
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
      }}
    >
      <span aria-hidden="true">{display.glyph}</span>
      {display.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// TaskCard — collapsible card for a single task
// ---------------------------------------------------------------------------

function TaskCard({ task, expanded, onToggle, index = 0 }) {
  const borderColor = taskTone(task.status).color;
  const taskTokens = tokensOf(task);

  return (
    <div
      onClick={onToggle}
      className="axon-card axon-press axon-rise"
      style={{
        ...riseStyle(index),
        borderLeft: `3px solid ${borderColor}`,
        borderRadius: 10,
        padding: "12px 14px",
      }}
      tabIndex={0}
      role="button"
      aria-expanded={expanded}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
    >
      {/* Top row: ID pill + intent badge + (when in_progress) role chip */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: 10,
            fontFamily: MONO,
            color: COLORS.textDim,
            background: COLORS.border,
            padding: "2px 8px",
            borderRadius: 10,
          }}
        >
          {task.id}
        </span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: TONES.neutral.color,
            background: TONES.neutral.dim,
            padding: "2px 8px",
            borderRadius: 10,
          }}
        >
          {task.intent}
        </span>
        {task.status === "in_progress" && <RoleChip role={task.role} />}
        <BackendBadge backend={task.backend} />
      </div>

      {/* Description */}
      <div
        style={{
          fontSize: 13,
          color: COLORS.text,
          lineHeight: 1.4,
          overflow: expanded ? "visible" : "hidden",
          textOverflow: expanded ? "unset" : "ellipsis",
          whiteSpace: expanded ? "normal" : "nowrap",
        }}
      >
        {task.description}
      </div>

      {/* Failure reason — surfaced on every failed card (collapsed AND
          expanded) so the column is glance-readable without clicking. */}
      {(task.status === "failed" || task.status === "blocked") && task.failureReason && (
        <div
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: `1px solid ${COLORS.border}`,
            fontSize: 12,
            lineHeight: 1.4,
            color: borderColor,
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 10, marginTop: 2 }}>⚠</span>
          <span style={{ flex: 1 }}>
            <span
              style={{
                fontSize: 10,
                textTransform: "uppercase",
                color: COLORS.textDim,
                marginRight: 6,
                letterSpacing: 0.4,
              }}
            >
              Reason
            </span>
            {task.failureReason}
          </span>
        </div>
      )}

      {/* Expanded details */}
      {expanded && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
            marginTop: 12,
            paddingTop: 12,
            borderTop: `1px solid ${COLORS.border}`,
          }}
        >
          {taskTokens != null && (
            <div>
              <span style={{ fontSize: 10, color: COLORS.textDim, textTransform: "uppercase" }}>
                Tokens
              </span>
              <div style={{ fontSize: 14, fontFamily: MONO, color: COLORS.text, marginTop: 2 }}>
                {formatTokens(taskTokens)}
              </div>
              {tokenSplit(task) && (
                <div style={{ fontSize: 10, fontFamily: MONO, color: COLORS.textDim, marginTop: 2 }}>
                  {tokenSplit(task)}
                </div>
              )}
            </div>
          )}
          <div>
            <span style={{ fontSize: 10, color: COLORS.textDim, textTransform: "uppercase" }}>
              Latency
            </span>
            <div style={{ fontSize: 14, fontFamily: MONO, color: COLORS.text, marginTop: 2 }}>
              {task.latencyMs != null ? `${(task.latencyMs / 1000).toFixed(1)}s` : "--"}
            </div>
          </div>
          <div>
            <span style={{ fontSize: 10, color: COLORS.textDim, textTransform: "uppercase" }}>
              Verdict
            </span>
            <div
              style={{
                fontSize: 14,
                marginTop: 2,
                color: task.verdict === "approved" ? TONES.success.color : task.verdict === "rejected" ? TONES.failure.color : COLORS.textDim,
              }}
            >
              {task.verdict || "--"}
            </div>
          </div>
          <div>
            <span style={{ fontSize: 10, color: COLORS.textDim, textTransform: "uppercase" }}>
              Arbiter
            </span>
            <div
              style={{
                fontSize: 14,
                marginTop: 2,
                color: task.arbiterInvolved ? TONES.progress.color : COLORS.textDim,
              }}
            >
              {task.arbiterInvolved ? "Yes" : "No"}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TaskBoard — Kanban with 4 columns
// ---------------------------------------------------------------------------

const TASK_COLUMNS = [
  { key: "pending", label: "Pending", tone: TONES.active },
  { key: "in_progress", label: "In Progress", tone: TONES.progress },
  { key: "completed", label: "Completed", tone: TONES.success },
  { key: "failed", label: "Failed / Blocked", tone: TONES.failure },
];

function TaskBoard({ tasks, expandedTasks, setExpandedTasks }) {
  if (!tasks || tasks.length === 0) return null;

  const grouped = {
    pending: tasks.filter((t) => t.status === "pending").sort((a, b) => a.order - b.order),
    in_progress: tasks.filter((t) => t.status === "in_progress").sort((a, b) => a.order - b.order),
    completed: tasks.filter((t) => t.status === "completed").sort((a, b) => a.order - b.order),
    failed: tasks.filter((t) => t.status === "failed" || t.status === "blocked").sort((a, b) => a.order - b.order),
  };

  const toggleTask = (id) => {
    setExpandedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: 12,
        maxHeight: 600,
        overflow: "auto",
        // Room for the cards' raised shadows and their entry overshoot.
        padding: "4px 8px 16px",
      }}
    >
      {TASK_COLUMNS.map((col) => {
        const colTasks = grouped[col.key];
        // Split In-Progress count into editing vs planning_ahead so the
        // header is honest about how many workers are actually editing
        // files vs speculatively planning ahead. (`role` defaults to
        // "editing" when unset, matching TaskRole's documented default.)
        const editingCount =
          col.key === "in_progress"
            ? colTasks.filter((t) => (t.role ?? "editing") === "editing").length
            : null;
        const planningCount =
          col.key === "in_progress"
            ? colTasks.filter((t) => t.role === "planning_ahead").length
            : null;
        const showSplit = col.key === "in_progress" && planningCount > 0;

        return (
        <div key={col.key} style={{ minWidth: 0, overflow: "visible", padding: "0 4px" }}>
          {/* Column header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 12,
              paddingBottom: 8,
              borderBottom: `2px solid ${col.tone.color}`,
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: COLORS.text,
              }}
            >
              {col.label}
            </span>
            <span
              style={{
                fontSize: 11,
                fontFamily: MONO,
                color: col.tone.color,
                background: col.tone.dim,
                padding: "1px 8px",
                borderRadius: 10,
              }}
            >
              {colTasks.length}
            </span>
            {showSplit && (
              <span
                style={{
                  fontSize: 11,
                  fontFamily: MONO,
                  color: COLORS.textDim,
                  marginLeft: "auto",
                  whiteSpace: "nowrap",
                }}
                title="In Progress count split by role. Editing = worker actively touching files; planning ahead = speculative sub-decomposition not yet promoted to active implementation."
              >
                {editingCount} editing · {planningCount} planning ahead
              </span>
            )}
          </div>

          {/* Cards */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {grouped[col.key].map((task, i) => (
              <TaskCard
                key={task.id}
                task={task}
                index={i}
                expanded={expandedTasks.has(task.id)}
                onToggle={() => toggleTask(task.id)}
              />
            ))}
            {grouped[col.key].length === 0 && (
              <div
                style={{
                  fontSize: 12,
                  color: COLORS.textDim,
                  textAlign: "center",
                  padding: "20px 0",
                  fontStyle: "italic",
                }}
              >
                No tasks
              </div>
            )}
          </div>
        </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BranchTopology — branch list with status dots
// ---------------------------------------------------------------------------

function BranchTopology({ branches }) {
  if (!branches || branches.length === 0) return null;

  function branchDotColor(status) {
    switch (status) {
      case "committed":
        return TONES.success.color;
      case "partial":
        return TONES.progress.color;
      case "abandoned":
        return TONES.failure.color;
      default:
        return TONES.neutral.color;
    }
  }

  return (
    <div
      className="axon-panel"
      style={{
        borderRadius: 14,
        padding: 24,
        marginTop: 28,
      }}
    >
      <SectionHeader subtitle="Git branches associated with tasks">
        Branches
      </SectionHeader>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {branches.map((branch) => (
          <div
            key={branch.name}
            className="axon-card"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 14px",
              borderRadius: 8,
            }}
          >
            {/* Status dot */}
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: branchDotColor(branch.status),
                flexShrink: 0,
              }}
            />

            {/* Branch name */}
            <span
              style={{
                fontSize: 13,
                fontFamily: MONO,
                color: COLORS.text,
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {branch.name}
            </span>

            {/* Task ID pill */}
            <span
              style={{
                fontSize: 10,
                fontFamily: MONO,
                color: COLORS.textDim,
                background: COLORS.border,
                padding: "2px 8px",
                borderRadius: 10,
                flexShrink: 0,
              }}
            >
              {branch.taskId}
            </span>

            {/* Status text */}
            <span
              style={{
                fontSize: 12,
                color: branchDotColor(branch.status),
                flexShrink: 0,
              }}
            >
              {branch.status}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ErrorPanel — aggregated error cards sorted by count
// ---------------------------------------------------------------------------

function ErrorPanel({ errors }) {
  if (!errors || errors.length === 0) return null;

  const totalErrors = errors.reduce((sum, e) => sum + e.count, 0);
  const sorted = [...errors].sort((a, b) => b.count - a.count);

  return (
    <div
      className="axon-panel"
      style={{
        borderRadius: 14,
        padding: 24,
      }}
    >
      <SectionHeader subtitle={`${totalErrors} total errors across ${errors.length} types`}>
        Error Aggregation
      </SectionHeader>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {sorted.map((err) => (
          <div
            key={err.type}
            className="axon-card"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              borderLeft: `3px solid ${TONES.failure.color}`,
              borderRadius: 8,
              padding: "12px 16px",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  color: COLORS.text,
                  lineHeight: 1.4,
                }}
              >
                {err.message}
              </div>
              <div
                style={{
                  fontSize: 11,
                  fontFamily: MONO,
                  color: COLORS.textDim,
                  marginTop: 4,
                }}
              >
                {err.type}
              </div>
            </div>
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                fontFamily: MONO,
                color: TONES.failure.color,
                background: TONES.failure.dim,
                padding: "3px 10px",
                borderRadius: 10,
                flexShrink: 0,
                marginLeft: 12,
              }}
            >
              {err.count}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab-specific components
// ---------------------------------------------------------------------------

function OversightFunnel({ data }) {
  const stages = [
    { label: "Total Sessions", value: data.total, color: TONES.neutral.color },
    { label: "Review Skipped", value: data.workerOnly, color: COLORS.textDim },
    {
      label: "Approved (1st pass)",
      value: data.reviewerApproved,
      color: TONES.success.color,
    },
    {
      label: "Retry → Approved",
      value: data.reviewerRejectedRetried,
      color: TONES.progress.color,
    },
    {
      label: "Arbiter Resolved",
      value: data.arbiterResolved,
      color: TONES.progress.color,
    },
    {
      label: "Human Escalated",
      value: data.humanEscalated,
      color: TONES.failure.color,
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {stages.map((stage, i) => {
        const pct = ((stage.value / data.total) * 100).toFixed(0);
        const barWidth = Math.max((stage.value / data.total) * 100, 4);
        return (
          <div
            key={i}
            style={{ display: "flex", alignItems: "center", gap: 12 }}
          >
            <span
              style={{
                fontSize: 12,
                color: COLORS.textDim,
                width: 140,
                textAlign: "right",
                flexShrink: 0,
              }}
            >
              {stage.label}
            </span>
            <div
              style={{
                flex: 1,
                height: 24,
                background: COLORS.border,
                borderRadius: 4,
                overflow: "hidden",
                position: "relative",
              }}
            >
              <div
                style={{
                  width: `${barWidth}%`,
                  height: "100%",
                  background: stage.color,
                  borderRadius: 4,
                  opacity: 0.8,
                  transition: `width ${MOTION.slow} ${MOTION.standard}`,
                }}
              />
            </div>
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: stage.color,
                width: 50,
                fontFamily: MONO,
              }}
            >
              {stage.value}{" "}
              <span style={{ fontSize: 10, color: COLORS.textDim }}>
                ({pct}%)
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConflictFunnel — worktree conflict resolution funnel
// ---------------------------------------------------------------------------

function ConflictFunnel({ data }) {
  if (!data) return null;

  const stages = [
    { label: "Tasks Decomposed", value: data.tasksDecomposed, color: TONES.neutral.color },
    { label: "Claims Registered", value: data.claimsRegistered, color: TONES.neutral.color },
    { label: "Conflicts Detected", value: data.conflictsDetected, color: TONES.progress.color },
    { label: "Serialized", value: data.serialized, color: TONES.success.color },
    { label: "Merged Clean", value: data.mergedClean, color: TONES.success.color },
    { label: "Merge Conflicts", value: data.mergeConflicts, color: TONES.failure.color },
    { label: "Remediated", value: data.remediated, color: TONES.success.color },
    { label: "Escalated", value: data.escalated, color: TONES.failure.color },
  ];

  const normalizedStages = stages.map((stage) => {
    const raw = Number(stage.value);
    const safeValue = Number.isFinite(raw) ? raw : 0;
    return { ...stage, value: safeValue };
  });

  const maxValue = Math.max(...normalizedStages.map((s) => s.value), 1);
  const rawTotal = Number(data?.tasksDecomposed);
  const totalTasksDecomposed = Number.isFinite(rawTotal) && rawTotal > 0 ? rawTotal : 0;

  return (
    <div style={{ marginTop: 32 }}>
      <h3 style={{ color: COLORS.text, marginBottom: 16 }}>
        Conflict Resolution Funnel
      </h3>
      <div className="axon-panel" style={{ borderRadius: 14, padding: 16 }}>
        {normalizedStages.map((stage, i) => {
          const widthPct = Math.max((stage.value / maxValue) * 100, 8);
          const pctOfTotal = totalTasksDecomposed > 0
            ? ((stage.value / totalTasksDecomposed) * 100).toFixed(1)
            : "0.0";
          return (
            <div key={i} style={{ marginBottom: 8 }}>
              <div style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 12,
                color: COLORS.textDim,
                marginBottom: 4,
              }}>
                <span>{stage.label}</span>
                <span style={{ fontFamily: MONO }}>{stage.value} ({pctOfTotal}%)</span>
              </div>
              <div style={{
                height: 20,
                width: `${widthPct}%`,
                background: stage.color,
                borderRadius: 4,
                opacity: 0.8,
              }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ModelComparisonTable({ data }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 13,
        }}
      >
        <thead>
          <tr style={{ borderBottom: `1px solid ${COLORS.border}` }}>
            {[
              "Model",
              "Backend",
              "1st Pass",
              "Arbiter %",
              "Escalation %",
              "Avg Tokens",
              "Latency",
            ].map((h) => (
              <th
                key={h}
                style={{
                  padding: "10px 12px",
                  textAlign: "left",
                  color: COLORS.textDim,
                  fontWeight: 500,
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr
              key={i}
              style={{ borderBottom: `1px solid ${COLORS.border}` }}
            >
              <td
                style={{
                  padding: "10px 12px",
                  color: COLORS.text,
                  fontWeight: 600,
                  fontFamily: MONO,
                }}
              >
                {row.model}
              </td>
              <td style={{ padding: "10px 12px" }}>
                <BackendBadge backend={row.backend} />
              </td>
              <td
                style={{
                  padding: "10px 12px",
                  fontFamily: MONO,
                  color:
                    row.firstPass >= 0.85
                      ? TONES.success.color
                      : row.firstPass >= 0.75
                        ? TONES.progress.color
                        : TONES.failure.color,
                }}
              >
                {(row.firstPass * 100).toFixed(0)}%
              </td>
              <td
                style={{
                  padding: "10px 12px",
                  fontFamily: MONO,
                  color:
                    row.arbiterRate <= 0.1 ? TONES.success.color : TONES.progress.color,
                }}
              >
                {(row.arbiterRate * 100).toFixed(0)}%
              </td>
              <td
                style={{
                  padding: "10px 12px",
                  fontFamily: MONO,
                  color:
                    row.escalation <= 0.05 ? TONES.success.color : TONES.failure.color,
                }}
              >
                {(row.escalation * 100).toFixed(0)}%
              </td>
              <td
                style={{ padding: "10px 12px", fontFamily: MONO, color: row.avgTokens > 0 ? TONES.progress.color : COLORS.textDim }}
              >
                {row.avgTokens > 0 ? formatTokens(row.avgTokens) : "—"}
              </td>
              <td
                style={{ padding: "10px 12px", fontFamily: MONO, color: COLORS.textMuted }}
              >
                {(row.latency / 1000).toFixed(1)}s
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dashboard
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WorktreeHealth — worktree conflict and claim metrics
// ---------------------------------------------------------------------------

function WorktreeHealth({ data }) {
  if (!data) return null;

  const rateStatus = data.conflictRate <= 0.05 ? "good" : data.conflictRate <= 0.15 ? "warn" : "bad";
  const accuracyStatus = data.avgClaimAccuracy >= 0.7 ? "good" : "warn";

  return (
    <div style={{ marginTop: 32 }}>
      <h3 style={{ color: COLORS.text, marginBottom: 16 }}>
        Worktree Health
      </h3>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
        <MetricCard
          label="Conflict Rate"
          value={Number.isFinite(data.conflictRate) ? `${(data.conflictRate * 100).toFixed(1)}%` : "—"}
          status={rateStatus}
          index={0}
        />
        <MetricCard
          label="Claim Accuracy"
          value={Number.isFinite(data.avgClaimAccuracy) ? `${(data.avgClaimAccuracy * 100).toFixed(0)}%` : "—"}
          status={accuracyStatus}
          index={1}
        />
        <MetricCard
          label="Conflicts Prevented"
          value={String(data.conflictsPrevented)}
          status="good"
          index={2}
        />
        <MetricCard
          label="Clean Merges"
          value={`${data.cleanMerges}/${data.totalWorktrees}`}
          index={3}
        />
      </div>

      {data.topConflictFiles && data.topConflictFiles.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h4 style={{ color: COLORS.textDim, fontSize: 12, marginBottom: 8 }}>
            Top Conflict Files
          </h4>
          <div className="axon-panel" style={{ borderRadius: 14, padding: 12 }}>
            {data.topConflictFiles.map((f, i) => (
              <div key={i} style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "4px 8px",
                fontFamily: MONO,
                fontSize: 13,
                color: COLORS.text,
              }}>
                <span>{f.file}</span>
                <span style={{ color: TONES.failure.color }}>{f.conflicts}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SwarmDashboard({ externalData }) {
  const [activeView, setActiveView] = useState("summary");
  const [expandedTasks, setExpandedTasks] = useState(new Set());
  const [expandedEvents, setExpandedEvents] = useState(new Set());
  const toggleEvent = (idx) => {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  };
  const { data, source } = useTelemData(externalData);
  // Recharts animates in JS, which the stylesheet's reduced-motion rule cannot reach.
  const chartsAnimate = !usePrefersReducedMotion();

  // Hash routing
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.slice(1) || "summary";
      if (["summary", "health", "models", "oversight"].includes(hash)) {
        setActiveView(hash);
      }
    };
    handleHashChange(); // Read hash on mount
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    const hash = activeView === "summary" ? "" : activeView;
    if (window.location.hash.slice(1) !== hash) {
      window.location.hash = hash;
    }
  }, [activeView]);

  if (!data) {
    return (
      <div style={{ background: COLORS.bg, color: COLORS.textDim, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: SANS }}>
        Loading telemetry...
      </div>
    );
  }

  const current = data?.weekly?.[data.weekly.length - 1];
  const previous = data.weekly.length >= 2 ? data.weekly[data.weekly.length - 2] : null;

  const fpDelta = previous ? ((current.firstPass - previous.firstPass) * 100).toFixed(1) : null;
  const arbDelta = previous ? ((current.arbiterRate - previous.arbiterRate) * 100).toFixed(1) : null;
  const escDelta = previous ? ((current.escalationRate - previous.escalationRate) * 100).toFixed(1) : null;

  return (
    <div
      style={{
        background: COLORS.bg,
        color: COLORS.text,
        minHeight: "100vh",
        fontFamily: SANS,
        padding: "24px 32px",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 28,
        }}
      >
        <div>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 700,
              margin: 0,
              letterSpacing: "-0.02em",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <span style={{ color: COLORS.text }}>◆</span> Swarm Telemetry
          </h1>
          <p
            style={{
              fontSize: 12,
              color: COLORS.textDim,
              margin: "6px 0 0",
              fontFamily: MONO,
            }}
          >
            {data.swarmVersion} · Updated{" "}
            {new Date(data.lastUpdated).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </div>
        {activeView !== "summary" && (
          <button
            onClick={() => setActiveView("summary")}
            className="axon-btn axon-btn-text"
            style={{ fontSize: 13, padding: "4px 8px" }}
          >
            ← Back to Summary
          </button>
        )}
      </div>

      {/* ================================================================= */}
      {/* Summary View                                                      */}
      {/* ================================================================= */}
      {activeView === "summary" && (
        <>
          {/* Key Metrics */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 24 }}>
            <MetricCard
              label="First-Pass Rate"
              value={current ? `${(current.firstPass * 100).toFixed(0)}%` : "\u2014"}
              status={current?.firstPass >= 0.85 ? "green" : current?.firstPass >= 0.75 ? "amber" : "red"}
              subtext="approved without retries"
              index={0}
            />
            <MetricCard
              label="Tasks Done"
              value={data.goals ? `${data.goals.reduce((a, g) => a + g.completedTasks, 0)}/${data.goals.reduce((a, g) => a + g.totalTasks, 0)}` : "\u2014"}
              status="neutral"
              subtext="across all goals"
              index={1}
            />
            <MetricCard
              label="Total Tokens"
              value={data.totalTokens > 0 ? formatTokens(data.totalTokens) : "\u2014"}
              status={data.totalTokens > 0 ? "usage" : "neutral"}
              subtext="all input + output"
              index={2}
            />
            <MetricCard
              label="Arbiter Rate"
              value={current ? `${(current.arbiterRate * 100).toFixed(0)}%` : "\u2014"}
              status={current?.arbiterRate <= 0.1 ? "green" : current?.arbiterRate <= 0.15 ? "amber" : "red"}
              subtext="needed arbiter resolution"
              index={3}
            />
            <MetricCard
              label="Human Escalation"
              value={current ? `${(current.escalationRate * 100).toFixed(0)}%` : "\u2014"}
              status={current?.escalationRate <= 0.05 ? "green" : "red"}
              subtext="escalated to human"
              index={4}
            />
          </div>

          {/* Goal Progress */}
          {data.goals && data.goals.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <SectionHeader subtitle="Progress toward active goals">
                Goal Progress
              </SectionHeader>
              {data.goals.map((goal, i) => (
                <div key={goal.id} className="axon-card axon-rise" style={{
                  ...riseStyle(i),
                  borderRadius: 10,
                  padding: 16,
                  marginBottom: 10,
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span style={{ color: COLORS.text, fontSize: 13 }}>
                      {goal.description?.slice(0, 80) ?? goal.id}
                    </span>
                    <span style={{ color: COLORS.textMuted, fontFamily: MONO, fontSize: 12 }}>
                      {goal.completedTasks}/{goal.totalTasks} tasks
                      {tokensOf(goal) > 0 && ` | ${formatTokens(tokensOf(goal))} tokens`}
                    </span>
                    {(() => {
                      const goalTasks = (data.tasks ?? []).filter((t) => t.goalId === goal.id);
                      const ccCount = goalTasks.filter((t) => t.backend === "claude-code").length;
                      const apiCount = goalTasks.filter((t) => t.backend === "api").length;
                      if (ccCount === 0 && apiCount === 0) return null;
                      return (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 12 }}>
                          {ccCount > 0 && <><BackendBadge backend="claude-code" /><span style={{ fontFamily: MONO, fontSize: 11, color: COLORS.textDim }}>{ccCount}</span></>}
                          {apiCount > 0 && <><BackendBadge backend="api" /><span style={{ fontFamily: MONO, fontSize: 11, color: COLORS.textDim }}>{apiCount}</span></>}
                        </span>
                      );
                    })()}
                  </div>
                  <div style={{ height: 8, background: COLORS.border, borderRadius: 4, overflow: "hidden" }}>
                    <div style={{
                      height: "100%",
                      width: `${(goal.completedTasks / goal.totalTasks) * 100}%`,
                      background: goal.completedTasks === goal.totalTasks ? TONES.success.color : TONES.active.color,
                      borderRadius: 4,
                      transition: `width ${MOTION.slow} ${MOTION.standard}`,
                    }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Task Board */}
          {data.tasks && (
            <div style={{ marginBottom: 24 }}>
              <SectionHeader subtitle="Kanban view of all tasks">
                Task Board
              </SectionHeader>
              <TaskBoard tasks={data.tasks} expandedTasks={expandedTasks} setExpandedTasks={setExpandedTasks} />
            </div>
          )}

          {/* Event Log */}
          {data.events && data.events.length > 0 && (
            <EventLog
              events={data.events}
              expandedEvents={expandedEvents}
              onToggleEvent={toggleEvent}
            />
          )}

          {/* Drill-Down Links */}
          <div style={{ display: "flex", gap: 12, marginTop: 8, marginBottom: 24 }}>
            <DrillDownLink label="Health Details" view="health" setActiveView={setActiveView} />
            <DrillDownLink label="Model Comparison" view="models" setActiveView={setActiveView} />
            <DrillDownLink label="Oversight Funnel" view="oversight" setActiveView={setActiveView} />
          </div>
        </>
      )}

      {/* ================================================================= */}
      {/* Health Tab                                                        */}
      {/* ================================================================= */}
      {activeView === "health" && (
        <>
          {/* Metric cards */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
              marginBottom: 28,
            }}
          >
            <MetricCard
              label="First-Pass Rate"
              value={`${(current.firstPass * 100).toFixed(0)}%`}
              trend={fpDelta != null ? `${fpDelta > 0 ? "+" : ""}${fpDelta}%` : undefined}
              status={
                current.firstPass >= 0.85
                  ? "good"
                  : current.firstPass >= 0.75
                    ? "warn"
                    : "bad"
              }
              subtext="Target: ≥ 85%"
              index={0}
            />
            <MetricCard
              label="Arbiter Rate"
              value={`${(current.arbiterRate * 100).toFixed(0)}%`}
              trend={arbDelta != null ? `${arbDelta > 0 ? "+" : ""}${arbDelta}%` : undefined}
              status={
                current.arbiterRate <= 0.1
                  ? "good"
                  : current.arbiterRate <= 0.15
                    ? "warn"
                    : "bad"
              }
              subtext="Target: ≤ 10%"
              index={1}
            />
            <MetricCard
              label="Human Escalation"
              value={`${(current.escalationRate * 100).toFixed(0)}%`}
              trend={escDelta != null ? `${escDelta > 0 ? "+" : ""}${escDelta}%` : undefined}
              status={
                current.escalationRate <= 0.05
                  ? "good"
                  : current.escalationRate <= 0.1
                    ? "warn"
                    : "bad"
              }
              subtext="Target: ≤ 5%"
              index={2}
            />
            <MetricCard
              label="Sessions"
              value={current.sessions}
              trend={previous ? `+${current.sessions - previous.sessions}` : undefined}
              subtext="This week"
              index={3}
            />
            <MetricCard
              label="Avg Tokens"
              value={current.avgTokens > 0 ? formatTokens(current.avgTokens) : "—"}
              trend={
                current.avgTokens > 0 && previous?.avgTokens > 0
                  ? `${current.avgTokens >= previous.avgTokens ? "↑" : "↓"}${formatTokens(Math.abs(current.avgTokens - previous.avgTokens))}`
                  : undefined
              }
              status={current.avgTokens > 0 ? "usage" : "neutral"}
              subtext="Per session"
              index={4}
            />
          </div>

          {/* Weekly trend chart */}
          <div
            className="axon-panel"
            style={{
              borderRadius: 14,
              padding: 24,
              marginBottom: 28,
            }}
          >
            <SectionHeader subtitle="Rolling weekly performance">
              Health Trend
            </SectionHeader>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart
                data={data.weekly}
                margin={{ top: 5, right: 10, bottom: 5, left: 0 }}
              >
                <XAxis
                  dataKey="week"
                  tick={{ fill: COLORS.textDim, fontSize: 11, fontFamily: MONO }}
                  axisLine={{ stroke: COLORS.border }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: COLORS.textDim, fontSize: 11, fontFamily: MONO }}
                  axisLine={false}
                  tickLine={false}
                  domain={[0, 1]}
                  tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                />
                <Tooltip
                  content={
                    <CustomTooltip
                      formatter={(v) => `${(v * 100).toFixed(1)}%`}
                    />
                  }
                />
                <Line
                  type="monotone"
                  dataKey="firstPass"
                  stroke={TONES.success.color}
                  strokeWidth={2.5}
                  dot={{ fill: TONES.success.color, r: 4 }}
                  name="First Pass"
                  isAnimationActive={chartsAnimate}
                />
                <Line
                  type="monotone"
                  dataKey="arbiterRate"
                  stroke={TONES.progress.color}
                  strokeWidth={2}
                  dot={{ fill: TONES.progress.color, r: 3 }}
                  name="Arbiter Rate"
                  isAnimationActive={chartsAnimate}
                />
                <Line
                  type="monotone"
                  dataKey="escalationRate"
                  stroke={TONES.failure.color}
                  strokeWidth={2}
                  dot={{ fill: TONES.failure.color, r: 3 }}
                  name="Escalation"
                  isAnimationActive={chartsAnimate}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* By mode breakdown */}
          <div
            className="axon-panel"
            style={{
              borderRadius: 14,
              padding: 24,
            }}
          >
            <SectionHeader subtitle="First-pass acceptance rate per intent">
              Performance by Mode
            </SectionHeader>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart
                data={data.byMode}
                margin={{ top: 5, right: 10, bottom: 5, left: 0 }}
                layout="vertical"
              >
                <XAxis
                  type="number"
                  tick={{ fill: COLORS.textDim, fontSize: 11, fontFamily: MONO }}
                  axisLine={false}
                  tickLine={false}
                  domain={[0, 1]}
                  tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                />
                <YAxis
                  type="category"
                  dataKey="mode"
                  tick={{
                    fill: COLORS.textMuted,
                    fontSize: 12,
                    fontFamily: MONO,
                  }}
                  axisLine={false}
                  tickLine={false}
                  width={110}
                />
                <Tooltip
                  content={
                    <CustomTooltip
                      formatter={(v) => `${(v * 100).toFixed(1)}%`}
                    />
                  }
                />
                <Bar
                  dataKey="firstPass"
                  radius={[0, 4, 4, 0]}
                  name="First Pass Rate"
                  isAnimationActive={chartsAnimate}
                >
                  {data.byMode.map((entry, i) => (
                    <Cell
                      key={i}
                      fill={
                        entry.firstPass >= 0.85
                          ? TONES.success.color
                          : entry.firstPass >= 0.75
                            ? TONES.progress.color
                            : TONES.failure.color
                      }
                      opacity={0.8}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Error aggregation panel */}
          <div style={{ marginTop: 28 }}>
            <ErrorPanel errors={data.errors} />
          </div>

          {/* Worktree health */}
          <WorktreeHealth data={data.worktreeHealth} />
        </>
      )}

      {/* ================================================================= */}
      {/* Models Tab                                                        */}
      {/* ================================================================= */}
      {activeView === "models" && (
        <>
          <div
            className="axon-panel"
            style={{
              borderRadius: 14,
              padding: 24,
              marginBottom: 28,
            }}
          >
            <SectionHeader subtitle="Same swarm version, different models">
              Model Comparison
            </SectionHeader>
            <ModelComparisonTable data={data.modelComparison} />
          </div>

          <div
            className="axon-panel"
            style={{
              borderRadius: 14,
              padding: 24,
            }}
          >
            <SectionHeader subtitle="First-pass rate vs tokens per session">
              Token-Performance Tradeoff
            </SectionHeader>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart
                data={data.modelComparison}
                margin={{ top: 10, right: 10, bottom: 5, left: 0 }}
              >
                <XAxis
                  dataKey="model"
                  tick={{ fill: COLORS.textMuted, fontSize: 12, fontFamily: MONO }}
                  axisLine={{ stroke: COLORS.border }}
                  tickLine={false}
                />
                <YAxis
                  yAxisId="left"
                  tick={{ fill: COLORS.textDim, fontSize: 11, fontFamily: MONO }}
                  axisLine={false}
                  tickLine={false}
                  domain={[0, 1]}
                  tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fill: COLORS.textDim, fontSize: 11, fontFamily: MONO }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => formatTokens(v)}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend
                  wrapperStyle={{ fontSize: 12, color: COLORS.textMuted }}
                />
                <Bar
                  yAxisId="left"
                  dataKey="firstPass"
                  fill={TONES.success.color}
                  radius={[4, 4, 0, 0]}
                  name="First Pass %"
                  opacity={0.8}
                  isAnimationActive={chartsAnimate}
                />
                <Bar
                  yAxisId="right"
                  dataKey="avgTokens"
                  fill={TONES.progress.color}
                  radius={[4, 4, 0, 0]}
                  name="Avg Tokens"
                  opacity={0.6}
                  isAnimationActive={chartsAnimate}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      {/* ================================================================= */}
      {/* Oversight Tab                                                     */}
      {/* ================================================================= */}
      {activeView === "oversight" && (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
              marginBottom: 28,
            }}
          >
            <MetricCard
              label="Total Sessions"
              value={data.oversightFunnel.total}
              subtext="This week"
              index={0}
            />
            <MetricCard
              label="Auto-Resolved"
              value={`${(((data.oversightFunnel.total - data.oversightFunnel.humanEscalated) / data.oversightFunnel.total) * 100).toFixed(0)}%`}
              status="good"
              subtext="No human needed"
              index={1}
            />
            <MetricCard
              label="Arbiter Needed"
              value={data.oversightFunnel.arbiterResolved}
              status={
                data.oversightFunnel.arbiterResolved <= 5 ? "good" : "warn"
              }
              subtext="Disagreements resolved"
              index={2}
            />
            <MetricCard
              label="Human Escalated"
              value={data.oversightFunnel.humanEscalated}
              status={
                data.oversightFunnel.humanEscalated <= 3 ? "good" : "bad"
              }
              subtext="Required human decision"
              index={3}
            />
          </div>

          <div
            className="axon-panel"
            style={{
              borderRadius: 14,
              padding: 24,
            }}
          >
            <SectionHeader subtitle="How sessions flow through the oversight chain">
              Resolution Funnel
            </SectionHeader>
            <OversightFunnel data={data.oversightFunnel} />
          </div>

          <ConflictFunnel data={data.worktreeHealth?.conflictFunnel} />
        </>
      )}

      {/* Footer */}
      <div
        style={{
          marginTop: 32,
          paddingTop: 16,
          borderTop: `1px solid ${COLORS.border}`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: COLORS.textDim,
          }}
        >
          swarm-dashboard <span style={{ fontFamily: MONO }}>v0.1.0</span> · Reads from{" "}
          <span style={{ fontFamily: MONO }}>/telemetry/summaries/</span>
        </span>
        <span style={{ fontSize: 11, color: source === "live" || source === "api" || source === "api-meta" ? TONES.success.color : COLORS.textDim }}>
          {source === "live" ? "Local telemetry data" : source === "api" ? "API run data" : source === "api-meta" ? "API metadata (limited)" : "Sample data"}
        </span>
      </div>
    </div>
  );
}
