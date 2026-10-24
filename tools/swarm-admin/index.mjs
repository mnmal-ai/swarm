#!/usr/bin/env node

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  ScanCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const REGION = process.env.AWS_REGION || "us-east-1";
const RUN_INDEX_TABLE = process.env.SWARM_RUN_TABLE || "swarm-run-index";
const USER_ACCESS_TABLE = process.env.SWARM_ACCESS_TABLE || "swarm-user-access";
const BUCKET = process.env.SWARM_BUCKET || (() => {
  // Derive bucket name from AWS account — never hardcode account IDs in source
  console.error("Warning: SWARM_BUCKET not set. Set it to your telemetry S3 bucket name.");
  console.error("  export SWARM_BUCKET=swarm-telemetry-<your-account-id>");
  process.exit(1);
})();

// -----------------------------------------------------------------------------
// Clients
// -----------------------------------------------------------------------------

const ddbClient = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(ddbClient);
const s3 = new S3Client({ region: REGION });

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function printUsage() {
  console.log(`
swarm-admin — Admin CLI for the Swarm telemetry system

Uses AWS IAM credentials (configure with \`aws configure\`).

COMMANDS

  swarm-admin allow <username>       Add a user to the access allowlist
  swarm-admin revoke <username>      Remove a user from the access allowlist
  swarm-admin list-users             List all allowed users
  swarm-admin delete-run <runId>     Delete a run from DynamoDB and S3
  swarm-admin stats                  Show aggregate stats

EXAMPLES

  swarm-admin allow example-user
  swarm-admin revoke example-user
  swarm-admin list-users
  swarm-admin delete-run run-sample-project-b29842
  swarm-admin stats
`);
}

function pad(str, len) {
  const s = String(str);
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function formatTokens(tokens) {
  return tokens.toLocaleString("en-US");
}

// -----------------------------------------------------------------------------
// Commands
// -----------------------------------------------------------------------------

async function allowUser(username) {
  const adminIdentity = process.env.USER || process.env.USERNAME || "unknown";
  await ddb.send(
    new PutCommand({
      TableName: USER_ACCESS_TABLE,
      Item: {
        github_username: username,
        granted_by: adminIdentity,
        granted_at: new Date().toISOString(),
        access_level: "read",
      },
    })
  );
  console.log(`Granted read access to ${username}`);
}

async function revokeUser(username) {
  await ddb.send(
    new DeleteCommand({
      TableName: USER_ACCESS_TABLE,
      Key: { github_username: username },
    })
  );
  console.log(`Revoked access for ${username}`);
}

async function listUsers() {
  const result = await ddb.send(
    new ScanCommand({ TableName: USER_ACCESS_TABLE })
  );
  const items = result.Items || [];

  if (items.length === 0) {
    console.log("No users in the allowlist.");
    return;
  }

  // Sort by granted_at descending
  items.sort((a, b) => (b.granted_at || "").localeCompare(a.granted_at || ""));

  const header = `${pad("USERNAME", 24)} ${pad("ACCESS", 10)} ${pad("GRANTED BY", 20)} GRANTED AT`;
  console.log(header);
  console.log("-".repeat(header.length));

  for (const item of items) {
    console.log(
      `${pad(item.github_username || "", 24)} ${pad(item.access_level || "", 10)} ${pad(item.granted_by || "", 20)} ${item.granted_at || ""}`
    );
  }

  console.log(`\n${items.length} user(s) total`);
}

async function deleteRun(runId) {
  // Step 1: Find the run in DynamoDB to get its identity and S3 key
  const scanResult = await ddb.send(
    new ScanCommand({
      TableName: RUN_INDEX_TABLE,
      FilterExpression: "run_id = :rid",
      ExpressionAttributeValues: { ":rid": runId },
    })
  );

  const items = scanResult.Items || [];

  if (items.length === 0) {
    console.error(`Run not found: ${runId}`);
    process.exit(1);
  }

  const run = items[0];
  const identity = run.identity;
  const s3Key = run.s3_key;

  // Step 2: Delete from DynamoDB
  await ddb.send(
    new DeleteCommand({
      TableName: RUN_INDEX_TABLE,
      Key: { identity, run_id: runId },
    })
  );
  console.log(`Deleted DynamoDB record: identity=${identity}, run_id=${runId}`);

  // Step 3: Delete from S3 if s3_key is present
  if (s3Key) {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: s3Key,
      })
    );
    console.log(`Deleted S3 object: s3://${BUCKET}/${s3Key}`);
  }

  // Step 4: Also try to delete the cached report if it exists
  const reportKey = `reports/${runId}.json`;
  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: reportKey,
      })
    );
    console.log(`Deleted cached report: s3://${BUCKET}/${reportKey}`);
  } catch {
    // Report may not exist — that is fine
  }

  console.log(`\nRun ${runId} fully deleted.`);
}

async function showStats() {
  // Gather run index data
  let allRuns = [];
  let lastEvaluatedKey = undefined;

  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: RUN_INDEX_TABLE,
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );
    allRuns = allRuns.concat(result.Items || []);
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  // Gather user count
  const userResult = await ddb.send(
    new ScanCommand({
      TableName: USER_ACCESS_TABLE,
      Select: "COUNT",
    })
  );

  // Estimate S3 storage (list objects in batches)
  let totalSize = 0;
  let objectCount = 0;
  let continuationToken = undefined;

  do {
    const listResult = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        ContinuationToken: continuationToken,
      })
    );
    const contents = listResult.Contents || [];
    for (const obj of contents) {
      totalSize += obj.Size || 0;
      objectCount++;
    }
    continuationToken = listResult.IsTruncated
      ? listResult.NextContinuationToken
      : undefined;
  } while (continuationToken);

  // Compute aggregate stats from runs
  const uniqueIdentities = new Set(allRuns.map((r) => r.identity));
  const uniqueProjects = new Set(allRuns.map((r) => r.project).filter(Boolean));
  // Runs uploaded before swarm recorded tokens have no total_tokens; they count as 0.
  const totalTokens = allRuns.reduce(
    (sum, r) => sum + (typeof r.total_tokens === "number" ? r.total_tokens : 0),
    0
  );
  const totalGoals = allRuns.reduce(
    (sum, r) => sum + (r.goals_completed || 0),
    0
  );
  const totalTasks = allRuns.reduce(
    (sum, r) => sum + (r.tasks_completed || 0),
    0
  );

  console.log("SWARM TELEMETRY STATS");
  console.log("=".repeat(40));
  console.log(`Total runs:          ${allRuns.length}`);
  console.log(`Unique identities:   ${uniqueIdentities.size}`);
  console.log(`Unique projects:     ${uniqueProjects.size}`);
  console.log(`Allowed users:       ${userResult.Count || 0}`);
  console.log(`Total goals done:    ${totalGoals}`);
  console.log(`Total tasks done:    ${totalTasks}`);
  console.log(`Total tokens:        ${formatTokens(totalTokens)}`);
  console.log("");
  console.log("S3 STORAGE");
  console.log("-".repeat(40));
  console.log(`Objects:             ${objectCount}`);
  console.log(`Total size:          ${formatBytes(totalSize)}`);
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "help" || command === "--help" || command === "-h") {
  printUsage();
  process.exit(0);
}

try {
  switch (command) {
    case "allow": {
      const username = args[1];
      if (!username) {
        console.error("Usage: swarm-admin allow <username>");
        process.exit(1);
      }
      await allowUser(username);
      break;
    }

    case "revoke": {
      const username = args[1];
      if (!username) {
        console.error("Usage: swarm-admin revoke <username>");
        process.exit(1);
      }
      await revokeUser(username);
      break;
    }

    case "list-users": {
      await listUsers();
      break;
    }

    case "delete-run": {
      const runId = args[1];
      if (!runId) {
        console.error("Usage: swarm-admin delete-run <runId>");
        process.exit(1);
      }
      await deleteRun(runId);
      break;
    }

    case "stats": {
      await showStats();
      break;
    }

    default:
      console.error(`Unknown command: ${command}\n`);
      printUsage();
      process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  if (
    err.name === "CredentialsProviderError" ||
    err.name === "ExpiredTokenException"
  ) {
    console.error(
      "\nMake sure AWS credentials are configured: run `aws configure`"
    );
  }
  process.exit(1);
}
