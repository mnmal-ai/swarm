/**
 * Swarm Telemetry API — Lambda handler.
 *
 * Routes:
 *   POST /upload-url          — generate presigned S3 PUT URL
 *   GET  /runs                — list runs (GitHub auth required)
 *   GET  /runs/{runId}        — get run detail + download URL
 *   GET  /runs/{runId}/report — get cached grade report
 *   PUT  /admin/allowlist     — add/remove users (IAM auth)
 *   GET  /admin/allowlist     — list allowed users (IAM auth)
 *   DELETE /admin/runs/{runId} — delete a run (IAM auth)
 *   GET  /admin/stats         — aggregate stats (IAM auth)
 *   GET  /admin/runs          — list all runs (IAM auth)
 */

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand, DeleteCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const BUCKET = process.env.BUCKET_NAME;
const RUN_TABLE = process.env.RUN_INDEX_TABLE;
const ACCESS_TABLE = process.env.USER_ACCESS_TABLE;

// Max tarball size: 100MB
const MAX_UPLOAD_SIZE = 100 * 1024 * 1024;

// The repository whose collaborators may read runs without an allowlist entry.
export const COLLABORATOR_REPO = "mnmal-ai/swarm";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The run's size in tokens (all input, cache included, plus output), as the
 * upload body reports it; 0 when absent or not a number.
 */
function tokensFrom(value) {
  return isNonNegativeNumber(value) ? value : 0;
}

function isNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body),
  };
}

/**
 * Verify a GitHub token and return the username.
 * Returns null if invalid.
 */
async function verifyGitHubToken(token) {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "swarm-telemetry" },
    });
    if (res.ok) {
      const data = await res.json();
      return data.login;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Check if a GitHub user has access.
 * First checks if they're a collaborator on the swarm repo,
 * then falls back to the DynamoDB allowlist.
 */
async function isUserAllowed(username) {
  // Check repo collaborator status using a service token (not the user's token).
  // The user's token may lack repo scope, causing a 404 that silently bypasses this check.
  // GITHUB_SERVICE_TOKEN should be a PAT with repo scope, set as a Lambda env var.
  const serviceToken = process.env.GITHUB_SERVICE_TOKEN;
  if (serviceToken) {
    try {
      const res = await fetch(`https://api.github.com/repos/${COLLABORATOR_REPO}/collaborators/${username}`, {
        headers: { Authorization: `Bearer ${serviceToken}`, "User-Agent": "swarm-telemetry" },
      });
      if (res.status === 204) return true; // 204 = is a collaborator
    } catch { /* fall through to allowlist */ }
  }

  // Fallback: check DynamoDB allowlist (for non-collaborators granted explicit access)
  const result = await ddb.send(new GetCommand({
    TableName: ACCESS_TABLE,
    Key: { github_username: username },
  }));
  return !!result.Item;
}

// ---------------------------------------------------------------------------
// Route: POST /upload-url
// ---------------------------------------------------------------------------

async function handleUploadUrl(body) {
  // swarm reports `total_tokens`. An older client sends `total_cost_usd`
  // instead; it is still accepted and stored, never required.
  const { identity_type, identity, run_id, project, timestamp,
    duration_ms, total_tokens, total_cost_usd, goals_completed, goals_total,
    tasks_completed, tasks_failed, swarm_sdk_version } = body;

  if (!identity || !run_id) {
    return respond(400, { error: "identity and run_id are required" });
  }

  const prefix = identity_type === "github" ? `github/${identity}` : `anon/${identity}`;
  const s3Key = `${prefix}/${run_id}/swarm-upload-${run_id}.tar.gz`;

  // Generate presigned PUT URL
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: s3Key,
    ContentType: "application/gzip",
  });
  const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 900 });

  // Write run metadata to DynamoDB
  const identityKey = identity_type === "github" ? `github:${identity}` : `anon:${identity}`;
  await ddb.send(new PutCommand({
    TableName: RUN_TABLE,
    Item: {
      identity: identityKey,
      run_id,
      project: project || "unknown",
      timestamp: timestamp || new Date().toISOString(),
      duration_ms: duration_ms || 0,
      total_tokens: tokensFrom(total_tokens),
      // Only a sane value from an older client is kept: a negative or
      // non-finite one would skew the admin stats' totals.
      ...(isNonNegativeNumber(total_cost_usd) ? { total_cost_usd } : {}),
      goals_completed: goals_completed || 0,
      goals_total: goals_total || 0,
      tasks_completed: tasks_completed || 0,
      tasks_failed: tasks_failed || 0,
      swarm_sdk_version: swarm_sdk_version || "unknown",
      s3_key: s3Key,
    },
  }));

  return respond(200, { presigned_url: presignedUrl, expires_in: 900 });
}

// ---------------------------------------------------------------------------
// Route: GET /runs
// ---------------------------------------------------------------------------

async function handleListRuns(queryParams, username) {
  const { user, project, from, to, limit } = queryParams || {};
  const maxItems = Math.min(parseInt(limit) || 50, 200);

  let items;

  if (project) {
    // Query by project using GSI
    // "project" and "timestamp" are DynamoDB reserved keywords — must use aliases
    const params = {
      TableName: RUN_TABLE,
      IndexName: "project-date-index",
      KeyConditionExpression: "#proj = :p",
      ExpressionAttributeNames: { "#proj": "project" },
      ExpressionAttributeValues: { ":p": project },
      Limit: maxItems,
      ScanIndexForward: false, // newest first
    };
    if (from) {
      params.KeyConditionExpression += " AND #ts >= :from";
      params.ExpressionAttributeNames["#ts"] = "timestamp";
      params.ExpressionAttributeValues[":from"] = from;
    }
    const result = await ddb.send(new QueryCommand(params));
    items = result.Items || [];
  } else if (user) {
    // Query by identity — "identity" is a DynamoDB reserved keyword
    const identityKey = user.startsWith("anon:") ? user : `github:${user}`;
    const result = await ddb.send(new QueryCommand({
      TableName: RUN_TABLE,
      KeyConditionExpression: "#ident = :id",
      ExpressionAttributeNames: { "#ident": "identity" },
      ExpressionAttributeValues: { ":id": identityKey },
      Limit: maxItems,
      ScanIndexForward: false,
    }));
    items = result.Items || [];
  } else {
    // Scan all (limited) — admin-like access for allowed users
    const result = await ddb.send(new ScanCommand({
      TableName: RUN_TABLE,
      Limit: maxItems,
    }));
    items = result.Items || [];
  }

  return respond(200, {
    runs: items.map(item => ({
      run_id: item.run_id,
      identity: item.identity,
      project: item.project,
      timestamp: item.timestamp,
      duration_ms: item.duration_ms,
      // null for a run uploaded before tokens were recorded.
      total_tokens: item.total_tokens ?? null,
      // Only runs uploaded by an older client carry a dollar figure.
      total_cost_usd: item.total_cost_usd,
      goals_completed: item.goals_completed,
      goals_total: item.goals_total,
      tasks_completed: item.tasks_completed,
      tasks_failed: item.tasks_failed,
      swarm_sdk_version: item.swarm_sdk_version,
    })),
  });
}

// ---------------------------------------------------------------------------
// Route: GET /runs/{runId}
// ---------------------------------------------------------------------------

async function handleGetRun(runId, username) {
  // TODO: Replace Scan with Query on a GSI (run_id). Scan is O(n) on the table.
  const result = await ddb.send(new ScanCommand({
    TableName: RUN_TABLE,
    FilterExpression: "run_id = :rid",
    ExpressionAttributeValues: { ":rid": runId },
  }));

  if (!result.Items || result.Items.length === 0) {
    return respond(404, { error: "Run not found" });
  }

  const item = result.Items[0];

  // Generate presigned GET URL for download
  const downloadUrl = await getSignedUrl(s3, new GetObjectCommand({
    Bucket: BUCKET,
    Key: item.s3_key,
  }), { expiresIn: 3600 });

  return respond(200, { meta: item, download_url: downloadUrl });
}

// ---------------------------------------------------------------------------
// Route: GET /runs/{runId}/report
// ---------------------------------------------------------------------------

async function handleGetReport(runId) {
  // Check for cached report
  const cacheKey = `reports/${runId}.json`;
  try {
    const cached = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: cacheKey }));
    const body = await cached.Body.transformToString();
    return respond(200, JSON.parse(body));
  } catch { /* not cached yet */ }

  // TODO: Replace Scan with Query on a GSI (run_id). Scan is O(n) on the table.
  const scanResult = await ddb.send(new ScanCommand({
    TableName: RUN_TABLE,
    FilterExpression: "run_id = :rid",
    ExpressionAttributeValues: { ":rid": runId },
  }));

  if (!scanResult.Items || scanResult.Items.length === 0) {
    return respond(404, { error: "Run not found" });
  }

  // TODO: Extract report.json from tarball, cache to S3, return.
  // For now, return a placeholder indicating the report needs extraction.
  return respond(202, {
    message: "Report extraction not yet implemented. Use 'swarm logs fetch' to download the full tarball and extract locally.",
    run_id: runId,
    s3_key: scanResult.Items[0].s3_key,
  });
}

// ---------------------------------------------------------------------------
// Admin routes
// ---------------------------------------------------------------------------

async function handleAdminAllowlistPut(body) {
  const { username, action: userAction, granted_by } = body;
  if (!username) return respond(400, { error: "username is required" });

  if (userAction === "revoke") {
    await ddb.send(new DeleteCommand({
      TableName: ACCESS_TABLE,
      Key: { github_username: username },
    }));
    return respond(200, { message: `Revoked access for ${username}` });
  }

  await ddb.send(new PutCommand({
    TableName: ACCESS_TABLE,
    Item: {
      github_username: username,
      granted_by: granted_by || "admin",
      granted_at: new Date().toISOString(),
      access_level: "read",
    },
  }));
  return respond(200, { message: `Granted read access to ${username}` });
}

async function handleAdminAllowlistGet() {
  const result = await ddb.send(new ScanCommand({ TableName: ACCESS_TABLE }));
  return respond(200, { users: result.Items || [] });
}

async function handleAdminDeleteRun(runId) {
  // TODO: Replace Scan with Query on a GSI (run_id). Scan is O(n) on the table.
  const scanResult = await ddb.send(new ScanCommand({
    TableName: RUN_TABLE,
    FilterExpression: "run_id = :rid",
    ExpressionAttributeValues: { ":rid": runId },
  }));

  if (!scanResult.Items || scanResult.Items.length === 0) {
    return respond(404, { error: "Run not found" });
  }

  const item = scanResult.Items[0];

  // Delete S3 object
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: item.s3_key }));
  } catch { /* may not exist */ }

  // Delete cached report if any
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `reports/${runId}.json` }));
  } catch { /* may not exist */ }

  // Delete DynamoDB record
  await ddb.send(new DeleteCommand({
    TableName: RUN_TABLE,
    Key: { identity: item.identity, run_id: runId },
  }));

  return respond(200, { message: `Deleted run ${runId}` });
}

async function handleAdminStats() {
  const scanResult = await ddb.send(new ScanCommand({ TableName: RUN_TABLE }));
  const items = scanResult.Items || [];

  const identities = new Set(items.map(i => i.identity));
  const totalTokens = items.reduce((sum, i) => sum + (i.total_tokens || 0), 0);
  // Dollar figures exist only on runs uploaded by an older client.
  const totalCost = items.reduce((sum, i) => sum + (i.total_cost_usd || 0), 0);
  const totalTasks = items.reduce((sum, i) => sum + (i.tasks_completed || 0) + (i.tasks_failed || 0), 0);

  // Estimate storage via ListObjects
  let totalSize = 0;
  try {
    const listResult = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 1000 }));
    totalSize = (listResult.Contents || []).reduce((sum, obj) => sum + (obj.Size || 0), 0);
  } catch { /* ignore */ }

  return respond(200, {
    total_runs: items.length,
    unique_identities: identities.size,
    total_tokens: totalTokens,
    total_cost_usd: Math.round(totalCost * 100) / 100,
    total_tasks: totalTasks,
    storage_bytes: totalSize,
    storage_mb: Math.round(totalSize / 1024 / 1024 * 100) / 100,
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function handler(event) {
  const method = event.httpMethod;
  const path = event.resource;
  const body = event.body ? JSON.parse(event.body) : {};
  const queryParams = event.queryStringParameters || {};
  const headers = event.headers || {};

  // Admin routes (IAM-authenticated by API Gateway — no additional check needed)
  if (path.startsWith("/admin")) {
    if (path === "/admin/allowlist" && method === "PUT") return handleAdminAllowlistPut(body);
    if (path === "/admin/allowlist" && method === "GET") return handleAdminAllowlistGet();
    if (path === "/admin/runs/{runId}" && method === "DELETE") return handleAdminDeleteRun(event.pathParameters?.runId);
    if (path === "/admin/stats" && method === "GET") return handleAdminStats();
    if (path === "/admin/runs" && method === "GET") {
      // Admin list all — no allowlist filter
      const result = await ddb.send(new ScanCommand({ TableName: RUN_TABLE, Limit: 200 }));
      return respond(200, { runs: result.Items || [] });
    }
    return respond(404, { error: "Not found" });
  }

  // Upload — lightweight auth (verify GitHub identity if claimed)
  if (path === "/upload-url" && method === "POST") {
    if (body.identity_type === "github") {
      const token = (headers.Authorization || headers.authorization || "").replace("Bearer ", "");
      if (!token) {
        return respond(401, { error: "Authorization header required for GitHub identity uploads" });
      }
      const verified = await verifyGitHubToken(token);
      if (!verified) {
        return respond(401, { error: "Invalid GitHub token" });
      }
      if (verified !== body.identity) {
        return respond(403, { error: `Token belongs to ${verified}, not ${body.identity}` });
      }
    }
    return handleUploadUrl(body);
  }

  // Read routes — require GitHub auth + allowlist
  const token = (headers.Authorization || headers.authorization || "").replace("Bearer ", "");
  if (!token) {
    return respond(401, { error: "Authorization header required. Use: swarm logs list" });
  }

  const username = await verifyGitHubToken(token);
  if (!username) {
    return respond(401, { error: "Invalid GitHub token" });
  }

  const allowed = await isUserAllowed(username);
  if (!allowed) {
    return respond(403, { error: `User ${username} is not a collaborator on ${COLLABORATOR_REPO} and not in the access list.` });
  }

  // Authenticated + authorized routes
  if (path === "/runs" && method === "GET") return handleListRuns(queryParams, username);
  if (path === "/runs/{runId}" && method === "GET") return handleGetRun(event.pathParameters?.runId, username);
  if (path === "/runs/{runId}/report" && method === "GET") return handleGetReport(event.pathParameters?.runId);

  return respond(404, { error: "Not found" });
}
