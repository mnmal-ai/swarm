import { useState, useEffect, useCallback } from "react";
import { formatTokens } from "../tokens.js";
import { COLORS, SANS, MONO, MOTION, TONES, riseStyle } from "../theme.js";
import { TELEMETRY_ENDPOINT } from "../telemetry-endpoint.js";

const API_BASE = TELEMETRY_ENDPOINT;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeDate(timestamp) {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDuration(ms) {
  if (!ms) return "--";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function truncateUser(identity) {
  if (!identity) return "unknown";
  if (identity.includes("@")) return identity.split("@")[0];
  return identity.length > 20 ? identity.slice(0, 20) : identity;
}

function matchesDateRange(timestamp, range) {
  if (range === "all") return true;
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const dayMs = 86400000;
  if (range === "today") return diffMs < dayMs;
  if (range === "7d") return diffMs < 7 * dayMs;
  if (range === "30d") return diffMs < 30 * dayMs;
  return true;
}

// ---------------------------------------------------------------------------
// RunCard
// ---------------------------------------------------------------------------

function RunCard({ run, onClick, index }) {
  const tasksCompleted = run.tasks_completed ?? 0;
  const tasksFailed = run.tasks_failed ?? 0;
  const tasksTotal = tasksCompleted + tasksFailed;
  const goalsCompleted = run.goals_completed ?? 0;
  const goalsTotal = run.goals_total ?? 0;
  // Runs uploaded before swarm recorded tokens have no total_tokens (or 0).
  const hasTokens = Number.isFinite(run.total_tokens) && run.total_tokens > 0;

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      className="axon-card axon-press axon-rise"
      style={{ ...styles.card, ...riseStyle(index) }}
    >
      {/* Row 1: Project + Date */}
      <div style={styles.cardTopRow}>
        <span style={styles.cardProject}>{run.project || "unknown"}</span>
        <span style={styles.cardDate}>{formatRelativeDate(run.timestamp)}</span>
      </div>

      {/* Row 2: User */}
      <div style={styles.cardUser}>{truncateUser(run.identity)}</div>

      {/* Row 3: Stats grid */}
      <div style={styles.statsGrid}>
        <div style={styles.statItem}>
          <span style={styles.statLabel}>Tasks</span>
          <span style={{
            ...styles.statValue,
            color: tasksFailed > 0 ? TONES.failure.color : TONES.success.color,
          }}>
            {tasksCompleted}/{tasksTotal}
          </span>
        </div>

        {goalsTotal > 0 && (
          <div style={styles.statItem}>
            <span style={styles.statLabel}>Goals</span>
            <span style={{
              ...styles.statValue,
              color: goalsCompleted === goalsTotal ? TONES.success.color : TONES.progress.color,
            }}>
              {goalsCompleted}/{goalsTotal}
            </span>
          </div>
        )}

        <div style={styles.statItem}>
          <span style={styles.statLabel}>Tokens</span>
          <span style={{ ...styles.statValue, color: hasTokens ? TONES.progress.color : COLORS.textDim }}>
            {hasTokens ? `${formatTokens(run.total_tokens)} tokens` : "—"}
          </span>
        </div>

        {run.duration_ms != null && (
          <div style={styles.statItem}>
            <span style={styles.statLabel}>Duration</span>
            <span style={styles.statValue}>
              {formatDuration(run.duration_ms)}
            </span>
          </div>
        )}
      </div>

      {/* SDK version badge */}
      {run.swarm_sdk_version && (
        <div style={styles.badgeRow}>
          <span style={styles.sdkBadge}>SDK {run.swarm_sdk_version}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LocalDataCard
// ---------------------------------------------------------------------------

function LocalDataCard({ onClick }) {
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      className="axon-card axon-press axon-rise"
      style={{ ...styles.card, ...riseStyle(0), borderLeft: `3px solid ${COLORS.accent}` }}
    >
      <div style={styles.cardTopRow}>
        <span style={{ ...styles.cardProject, color: COLORS.accent }}>Local Data</span>
        <span style={styles.localIcon}>{"◆"}</span>
      </div>
      <div style={{ fontSize: 11, color: COLORS.textDim, fontFamily: MONO, marginTop: 4 }}>
        data/latest.json
      </div>
      <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 8, lineHeight: 1.5 }}>
        View the dashboard with locally generated telemetry data or sample data.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FilterChip
// ---------------------------------------------------------------------------

function FilterChip({ label, active, onClick }) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: "4px 12px",
        borderRadius: 20,
        border: `1px solid ${active ? COLORS.accent : COLORS.borderLight}`,
        background: active ? COLORS.accentDim : (hovered ? COLORS.surfaceHover : "transparent"),
        color: active ? COLORS.accent : COLORS.textMuted,
        fontSize: 11,
        fontFamily: SANS,
        cursor: "pointer",
        transition: `background ${MOTION.fast} ${MOTION.standard}, border-color ${MOTION.fast} ${MOTION.standard}`,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// RunListPage
// ---------------------------------------------------------------------------

export default function RunListPage({ username, onLogout, onSelectRun, onSelectLocal }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState(null);
  const [dateRange, setDateRange] = useState("all");

  const fetchRuns = useCallback(() => {
    const token = localStorage.getItem("swarm_github_token");
    if (!token) {
      setError("No auth token");
      return;
    }

    setLoading(true);
    setError(null);

    fetch(`${API_BASE}/runs`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((json) => {
        if (json?.runs) {
          const sorted = [...json.runs].sort(
            (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
          );
          setRuns(sorted);
        }
        setLoading(false);
      })
      .catch((err) => {
        setError(`Failed to load runs: ${err.message}`);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  // Extract unique project names for filter chips
  const projectNames = [...new Set(runs.map((r) => r.project).filter(Boolean))].sort();

  // Apply filters
  const searchLower = search.toLowerCase();
  const filteredRuns = runs.filter((run) => {
    // Date range filter
    if (!matchesDateRange(run.timestamp, dateRange)) return false;

    // Project filter
    if (projectFilter && run.project !== projectFilter) return false;

    // Search filter
    if (searchLower) {
      const searchable = [
        run.project || "",
        run.identity || "",
        run.run_id || "",
        run.swarm_sdk_version || "",
      ].join(" ").toLowerCase();
      if (!searchable.includes(searchLower)) return false;
    }

    return true;
  });

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={styles.headerLogo}>{"◆"}</span>
          <h1 style={styles.headerTitle}>Swarm Telemetry</h1>
        </div>
        <div style={styles.headerRight}>
          <span style={styles.userText}>
            Logged in as <strong style={{ color: COLORS.text, fontFamily: MONO }}>{username}</strong>
          </span>
          <button onClick={onLogout} className="axon-btn axon-btn-text" style={styles.logoutBtn}>Log out</button>
        </div>
      </div>

      {/* Search bar */}
      <div style={styles.searchContainer}>
        <input
          type="text"
          placeholder="Search by project, user, run ID, or SDK version..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={styles.searchInput}
        />
        <button
          onClick={fetchRuns}
          disabled={loading}
          className="axon-btn axon-btn-secondary"
          style={styles.refreshBtn}
          title="Refresh runs"
        >
          {loading ? "..." : "\u21BB Refresh"}
        </button>
      </div>

      {/* Filter chips */}
      <div style={styles.filterRow}>
        {/* Date range chips */}
        <div style={styles.chipGroup}>
          <span style={styles.chipGroupLabel}>Date:</span>
          {[
            { key: "today", label: "Today" },
            { key: "7d", label: "Last 7 days" },
            { key: "30d", label: "Last 30 days" },
            { key: "all", label: "All" },
          ].map((opt) => (
            <FilterChip
              key={opt.key}
              label={opt.label}
              active={dateRange === opt.key}
              onClick={() => setDateRange(opt.key)}
            />
          ))}
        </div>

        {/* Project chips */}
        {projectNames.length > 1 && (
          <div style={styles.chipGroup}>
            <span style={styles.chipGroupLabel}>Project:</span>
            <FilterChip
              label="All"
              active={projectFilter === null}
              onClick={() => setProjectFilter(null)}
            />
            {projectNames.map((name) => (
              <FilterChip
                key={name}
                label={name}
                active={projectFilter === name}
                onClick={() => setProjectFilter(projectFilter === name ? null : name)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div style={styles.errorBox}>{error}</div>
      )}

      {/* Run grid */}
      <div style={styles.grid}>
        {/* Local data card -- always first */}
        <LocalDataCard onClick={onSelectLocal} />

        {/* Loading state */}
        {loading && runs.length === 0 && (
          <div style={styles.emptyState}>Loading runs...</div>
        )}

        {/* Run cards */}
        {filteredRuns.map((run, i) => (
          <RunCard
            key={run.run_id}
            run={run}
            index={i + 1}
            onClick={() => onSelectRun(run.run_id)}
          />
        ))}
      </div>

      {/* Empty state for search */}
      {!loading && runs.length > 0 && filteredRuns.length === 0 && (
        <div style={styles.emptyState}>
          No runs found matching your filters.
        </div>
      )}

      {/* Empty state for no runs at all */}
      {!loading && runs.length === 0 && !error && (
        <div style={styles.emptyState}>
          No runs found. Run a swarm session to see telemetry here.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = {
  page: {
    minHeight: "100vh",
    background: COLORS.bg,
    fontFamily: SANS,
    padding: "0 0 40px",
  },

  // Header
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 32px",
    borderBottom: `1px solid ${COLORS.border}`,
    flexWrap: "wrap",
    gap: 12,
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  headerLogo: {
    fontSize: 20,
    color: COLORS.text,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: COLORS.text,
    margin: 0,
    letterSpacing: "-0.02em",
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  userText: {
    color: COLORS.textMuted,
    fontSize: 11,
  },
  logoutBtn: {
    padding: "4px 4px",
    fontSize: 11,
  },

  // Search
  searchContainer: {
    display: "flex",
    gap: 10,
    padding: "16px 32px 0",
    alignItems: "center",
  },
  searchInput: {
    flex: 1,
    padding: "10px 16px",
    background: COLORS.bg,
    border: `1px solid ${COLORS.borderLight}`,
    borderRadius: 10,
    color: COLORS.text,
    fontFamily: SANS,
    fontSize: 13,
    outline: "none",
  },
  refreshBtn: {
    padding: "10px 16px",
    borderRadius: 10,
    fontSize: 12,
  },

  // Filters
  filterRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 16,
    padding: "12px 32px 0",
    alignItems: "center",
  },
  chipGroup: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  chipGroupLabel: {
    fontSize: 10,
    color: COLORS.textDim,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginRight: 2,
  },

  // Error
  errorBox: {
    margin: "12px 32px 0",
    padding: "10px 16px",
    background: TONES.failure.dim,
    borderLeft: `3px solid ${TONES.failure.color}`,
    borderRadius: 8,
    color: TONES.failure.color,
    fontSize: 12,
  },

  // Grid
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
    gap: 16,
    padding: "20px 32px 0",
  },

  // Card
  card: {
    borderRadius: 12,
    padding: "16px 20px",
    display: "flex",
    flexDirection: "column",
  },
  cardTopRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cardProject: {
    fontSize: 15,
    fontWeight: 700,
    color: COLORS.text,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  cardDate: {
    fontSize: 11,
    fontFamily: MONO,
    color: COLORS.textDim,
    flexShrink: 0,
  },
  cardUser: {
    fontSize: 11,
    fontFamily: MONO,
    color: COLORS.textMuted,
    marginTop: 4,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  localIcon: {
    fontSize: 14,
    color: COLORS.textDim,
  },

  // Stats
  statsGrid: {
    display: "flex",
    gap: 16,
    marginTop: 12,
    flexWrap: "wrap",
  },
  statItem: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  statLabel: {
    fontSize: 9,
    color: COLORS.textDim,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  },
  statValue: {
    fontSize: 13,
    fontWeight: 600,
    fontFamily: MONO,
    color: COLORS.text,
  },

  // Badge
  badgeRow: {
    marginTop: 10,
  },
  sdkBadge: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 4,
    background: COLORS.border,
    color: COLORS.textMuted,
    fontSize: 10,
    fontFamily: MONO,
    fontWeight: 600,
  },

  // Empty state
  emptyState: {
    textAlign: "center",
    padding: "40px 32px",
    color: COLORS.textDim,
    fontSize: 13,
  },
};
