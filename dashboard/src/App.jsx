import { useState, useEffect, useCallback } from "react";
import SwarmDashboard from "./components/SwarmDashboard.jsx";
import RunListPage from "./components/RunListPage.jsx";
import { COLORS, SANS, MONO, TONES } from "./theme.js";
import { TELEMETRY_ENDPOINT } from "./telemetry-endpoint.js";

const API_BASE = TELEMETRY_ENDPOINT;

/**
 * Auth gate -- validates GitHub token before showing the dashboard.
 * Token is stored in localStorage so you only log in once per browser.
 * The dashboard HTML is public (GitHub Pages) but the data is protected
 * behind the API's GitHub OAuth + allowlist.
 */
function AuthGate({ children }) {
  const [token, setToken] = useState(localStorage.getItem("swarm_github_token"));
  const [username, setUsername] = useState(localStorage.getItem("swarm_github_user"));
  const [checking, setChecking] = useState(!!token);
  const [error, setError] = useState(null);
  const [inputToken, setInputToken] = useState("");

  // Verify stored token on mount
  useEffect(() => {
    if (!token) { setChecking(false); return; }

    fetch(`${API_BASE}/runs?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => {
        if (r.ok) {
          setChecking(false);
        } else if (r.status === 401 || r.status === 403) {
          // Token invalid or user not in allowlist
          localStorage.removeItem("swarm_github_token");
          localStorage.removeItem("swarm_github_user");
          setToken(null);
          setUsername(null);
          setChecking(false);
          setError("Token expired or access revoked. Please log in again.");
        } else {
          setChecking(false); // API might be down -- let them through with cached data
        }
      })
      .catch(() => {
        setChecking(false); // Network error -- let them through
      });
  }, [token]);

  const handleLogin = async () => {
    setError(null);
    const t = inputToken.trim();
    if (!t) { setError("Please enter a token"); return; }

    try {
      // Verify the token with GitHub
      const ghRes = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${t}`, "User-Agent": "swarm-dashboard" },
      });
      if (!ghRes.ok) { setError("Invalid GitHub token"); return; }
      const ghUser = await ghRes.json();

      // Check if the user is in the allowlist
      const apiRes = await fetch(`${API_BASE}/runs?limit=1`, {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (apiRes.status === 403) {
        setError(`${ghUser.login} is not in the access list. Contact the swarm admin.`);
        return;
      }
      if (!apiRes.ok) {
        setError(`API error: ${apiRes.status}`);
        return;
      }

      // Success -- store and proceed
      localStorage.setItem("swarm_github_token", t);
      localStorage.setItem("swarm_github_user", ghUser.login);
      setToken(t);
      setUsername(ghUser.login);
    } catch (err) {
      setError(`Connection failed: ${err.message}`);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("swarm_github_token");
    localStorage.removeItem("swarm_github_user");
    setToken(null);
    setUsername(null);
  };

  if (checking) {
    return (
      <div style={styles.container}>
        <div className="axon-panel axon-rise" style={styles.card}>
          <div style={styles.logo}>{"◆"} Swarm Dashboard</div>
          <p style={styles.text}>Verifying access...</p>
        </div>
      </div>
    );
  }

  if (!token) {
    return (
      <div style={styles.container}>
        <div className="axon-panel axon-rise" style={styles.card}>
          <div style={styles.logo}>{"◆"} Swarm Dashboard</div>
          <p style={styles.text}>Enter your GitHub personal access token to access the dashboard.</p>
          <p style={styles.hint}>
            Generate one at{" "}
            <a href="https://github.com/settings/tokens" target="_blank" rel="noopener" style={styles.link}>
              github.com/settings/tokens
            </a>{" "}
            (no scopes needed) or run <code style={styles.code}>gh auth token</code>
          </p>
          <input
            type="password"
            placeholder="ghp_... or gho_..."
            value={inputToken}
            onChange={(e) => setInputToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            style={styles.input}
          />
          <button onClick={handleLogin} className="axon-btn axon-btn-primary" style={styles.button}>Log in</button>
          {error && <p style={styles.error}>{error}</p>}
        </div>
      </div>
    );
  }

  return children({ username, onLogout: handleLogout });
}

/**
 * Build a dashboard-compatible data object from API run metadata.
 * This provides enough structure for the summary cards to render.
 * Detailed views (task board, event log) require the full report from
 * the tarball, which is not yet available in-browser.
 */
function buildDashboardDataFromMeta(meta) {
  const goalsCompleted = meta.goals_completed ?? 0;
  const goalsTotal = meta.goals_total ?? 0;
  const tasksCompleted = meta.tasks_completed ?? 0;
  const tasksFailed = meta.tasks_failed ?? 0;
  // All input (cache reads and writes included) plus output. Runs uploaded
  // before swarm recorded tokens have none, so their token figures show "—".
  const totalTokens = Number.isFinite(meta.total_tokens) && meta.total_tokens > 0 ? meta.total_tokens : null;
  const tokensPer = (n) => (totalTokens != null && n > 0 ? Math.round(totalTokens / n) : null);
  const durationMs = meta.duration_ms ?? 0;

  return {
    swarmVersion: meta.swarm_sdk_version || "unknown",
    lastUpdated: meta.timestamp || new Date().toISOString(),
    totalTokens,

    weekly: [
      {
        week: "Run",
        firstPass: tasksFailed === 0 && tasksCompleted > 0 ? 1.0 : tasksCompleted > 0 ? tasksCompleted / (tasksCompleted + tasksFailed) : 0,
        arbiterRate: 0,
        escalationRate: 0,
        sessions: tasksCompleted + tasksFailed,
        avgTokens: tokensPer(tasksCompleted + tasksFailed),
      },
    ],

    byMode: [
      { mode: "completed", firstPass: 1.0, sessions: tasksCompleted, avgTokens: tokensPer(tasksCompleted) },
      ...(tasksFailed > 0 ? [{ mode: "failed", firstPass: 0, sessions: tasksFailed, avgTokens: null }] : []),
    ],

    modelComparison: [
      {
        model: meta.identity || "unknown",
        backend: "api",
        firstPass: tasksCompleted / Math.max(tasksCompleted + tasksFailed, 1),
        arbiterRate: 0,
        escalation: 0,
        avgTokens: tokensPer(Math.max(tasksCompleted + tasksFailed, 1)),
        latency: durationMs,
      },
    ],

    oversightFunnel: {
      total: tasksCompleted + tasksFailed,
      workerOnly: tasksCompleted,
      reviewerApproved: 0,
      reviewerRejectedRetried: 0,
      arbiterResolved: 0,
      humanEscalated: tasksFailed,
    },

    goals: goalsTotal > 0 ? [
      {
        id: "goal-1",
        description: `${meta.project || "Run"} (${goalsCompleted}/${goalsTotal} goals)`,
        completedTasks: tasksCompleted,
        totalTasks: tasksCompleted + tasksFailed,
        tokens: totalTokens,
      },
    ] : [],

    // These require the full report tarball -- not available from metadata
    tasks: null,
    events: null,
  };
}

/**
 * Banner shown above the dashboard when viewing an API run.
 * Shows metadata and a hint to fetch detailed data via CLI.
 */
function RunMetaBanner({ meta, runId }) {
  const [copied, setCopied] = useState(false);
  const command = `swarm logs fetch ${runId}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div style={styles.metaBanner}>
      <div style={styles.metaBannerRow}>
        <span style={styles.metaBannerLabel}>Run</span>
        <span style={styles.metaBannerValue}>{meta.project || runId}</span>
        <span style={styles.metaBannerSep} />
        <span style={styles.metaBannerLabel}>User</span>
        <span style={{ ...styles.metaBannerValue, fontFamily: MONO }}>{meta.identity || "unknown"}</span>
        <span style={styles.metaBannerSep} />
        <span style={styles.metaBannerLabel}>Duration</span>
        <span style={{ ...styles.metaBannerValue, fontFamily: MONO }}>
          {meta.duration_ms ? `${(meta.duration_ms / 1000 / 60).toFixed(1)}m` : "--"}
        </span>
        <span style={styles.metaBannerSep} />
        <span style={styles.metaBannerLabel}>SDK</span>
        <span style={{ ...styles.metaBannerValue, fontFamily: MONO }}>{meta.swarm_sdk_version || "--"}</span>
      </div>
      <div style={styles.metaBannerHint}>
        <span style={{ color: COLORS.textMuted }}>
          Detailed task board and event log available via CLI:
        </span>
        <button onClick={handleCopy} className="axon-btn axon-btn-secondary" style={styles.copyBtn}>
          <code style={styles.copyCode}>{command}</code>
          <span style={styles.copyLabel}>{copied ? "Copied!" : "Copy"}</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Back button shown at the top of the dashboard view.
 */
function BackButton({ onClick }) {
  return (
    <div style={styles.backBar}>
      <button onClick={onClick} className="axon-btn axon-btn-text" style={styles.backBtn}>
        &larr; Back to Runs
      </button>
    </div>
  );
}

/**
 * DashboardView -- loads and displays a single run's dashboard.
 *
 * For local source (selectedRunId = null): SwarmDashboard loads data/latest.json internally.
 * For API runs: fetches run metadata from the API and builds a summary view.
 */
function DashboardView({ selectedRunId, onBack }) {
  const [externalData, setExternalData] = useState(null);
  const [loadingRun, setLoadingRun] = useState(false);
  const [runMeta, setRunMeta] = useState(null);

  const loadRunData = useCallback((runId) => {
    const token = localStorage.getItem("swarm_github_token");
    if (!token) return;

    setLoadingRun(true);
    setRunMeta(null);

    fetch(`${API_BASE}/runs/${runId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((json) => {
        const meta = json?.meta;
        if (!meta) throw new Error("No metadata in response");

        setRunMeta(meta);

        const dashboardData = buildDashboardDataFromMeta(meta);
        setExternalData({ data: dashboardData, source: "api-meta" });
        setLoadingRun(false);
      })
      .catch(() => {
        setExternalData(null);
        setRunMeta(null);
        setLoadingRun(false);
      });
  }, []);

  useEffect(() => {
    if (selectedRunId === null) {
      // Local data mode -- clear external data so SwarmDashboard falls back to local file
      setExternalData(null);
      setRunMeta(null);
    } else {
      loadRunData(selectedRunId);
    }
  }, [selectedRunId, loadRunData]);

  return (
    <div style={styles.dashboardViewContainer}>
      <BackButton onClick={onBack} />

      {loadingRun && (
        <div style={styles.loadingOverlay}>
          <span style={styles.loadingText}>Loading run data...</span>
        </div>
      )}

      {selectedRunId !== null && !loadingRun && runMeta && (
        <RunMetaBanner meta={runMeta} runId={selectedRunId} />
      )}

      {selectedRunId !== null && !loadingRun && !runMeta && !externalData && (
        <div style={styles.loadingOverlay}>
          <span style={styles.loadingText}>Could not load run data</span>
        </div>
      )}

      <SwarmDashboard externalData={externalData} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = {
  // Auth gate styles
  container: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    background: COLORS.bg,
    fontFamily: SANS,
  },
  card: {
    borderRadius: 14,
    padding: 40,
    maxWidth: 420,
    width: "100%",
    textAlign: "center",
  },
  logo: {
    fontSize: 22,
    fontWeight: 700,
    color: COLORS.text,
    marginBottom: 16,
  },
  text: {
    color: COLORS.text,
    fontSize: 13,
    lineHeight: 1.6,
    marginBottom: 12,
  },
  hint: {
    color: COLORS.textDim,
    fontSize: 11,
    lineHeight: 1.5,
    marginBottom: 20,
  },
  link: { color: COLORS.accent },
  code: {
    background: COLORS.border,
    padding: "2px 6px",
    borderRadius: 4,
    fontSize: 11,
    fontFamily: MONO,
    color: COLORS.textMuted,
  },
  input: {
    width: "100%",
    padding: "10px 14px",
    background: COLORS.bg,
    border: `1px solid ${COLORS.borderLight}`,
    borderRadius: 10,
    color: COLORS.text,
    fontFamily: MONO,
    fontSize: 13,
    marginBottom: 12,
    outline: "none",
  },
  button: {
    width: "100%",
    padding: "11px 20px",
    borderRadius: 10,
    fontSize: 13,
  },
  error: {
    color: TONES.failure.color,
    fontSize: 12,
    marginTop: 12,
  },

  // Dashboard view container
  dashboardViewContainer: {
    minHeight: "100vh",
    background: COLORS.bg,
  },

  // Back button bar
  backBar: {
    padding: "8px 24px",
    background: COLORS.surface,
    borderBottom: `1px solid ${COLORS.border}`,
  },
  backBtn: {
    padding: "6px 4px",
    fontSize: 12,
  },

  // Loading
  loadingOverlay: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 40,
    fontFamily: SANS,
  },
  loadingText: {
    color: COLORS.textDim,
    fontSize: 13,
  },

  // Meta banner
  metaBanner: {
    padding: "12px 20px",
    background: COLORS.surface,
    borderBottom: `1px solid ${COLORS.border}`,
    fontFamily: SANS,
  },
  metaBannerRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
    marginBottom: 8,
  },
  metaBannerLabel: {
    fontSize: 10,
    color: COLORS.textDim,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  metaBannerValue: {
    fontSize: 12,
    color: COLORS.text,
    fontWeight: 600,
  },
  metaBannerSep: {
    width: 1,
    height: 14,
    background: COLORS.borderLight,
    margin: "0 4px",
  },
  metaBannerHint: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    fontSize: 11,
    flexWrap: "wrap",
  },
  copyBtn: {
    gap: 8,
    padding: "5px 12px",
    borderRadius: 8,
  },
  copyCode: {
    fontSize: 11,
    fontFamily: MONO,
    color: COLORS.accent,
  },
  copyLabel: {
    fontSize: 10,
    color: COLORS.textMuted,
  },
};

// ---------------------------------------------------------------------------
// App -- State machine: "list" | "dashboard"
// ---------------------------------------------------------------------------

export default function App() {
  const [view, setView] = useState("list");
  const [selectedRunId, setSelectedRunId] = useState(null);

  const handleSelectRun = (runId) => {
    setSelectedRunId(runId);
    setView("dashboard");
  };

  const handleSelectLocal = () => {
    setSelectedRunId(null);
    setView("dashboard");
  };

  const handleBack = () => {
    setView("list");
    setSelectedRunId(null);
  };

  return (
    <AuthGate>
      {({ username, onLogout }) => (
        view === "list" ? (
          <RunListPage
            username={username}
            onLogout={onLogout}
            onSelectRun={handleSelectRun}
            onSelectLocal={handleSelectLocal}
          />
        ) : (
          <DashboardView
            selectedRunId={selectedRunId}
            onBack={handleBack}
          />
        )
      )}
    </AuthGate>
  );
}
