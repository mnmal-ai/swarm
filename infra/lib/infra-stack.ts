import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as path from "node:path";

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -----------------------------------------------------------------------
    // S3 Bucket — stores uploaded tarballs
    // -----------------------------------------------------------------------
    const telemetryBucket = new s3.Bucket(this, "TelemetryBucket", {
      bucketName: `swarm-telemetry-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: "glacier-after-90-days",
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
          // No expiration — logs retained permanently
        },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
          maxAge: 3600,
        },
      ],
    });

    // -----------------------------------------------------------------------
    // DynamoDB — run index (queryable by identity, project, date)
    // -----------------------------------------------------------------------
    const runIndex = new dynamodb.Table(this, "RunIndex", {
      tableName: "swarm-run-index",
      partitionKey: { name: "identity", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "run_id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
    });

    // GSI for querying by project + date
    runIndex.addGlobalSecondaryIndex({
      indexName: "project-date-index",
      partitionKey: { name: "project", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.STRING },
    });

    // -----------------------------------------------------------------------
    // DynamoDB — user access (allowlist for read access)
    // -----------------------------------------------------------------------
    const userAccess = new dynamodb.Table(this, "UserAccess", {
      tableName: "swarm-user-access",
      partitionKey: { name: "github_username", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // -----------------------------------------------------------------------
    // Lambda — handles all API routes
    // -----------------------------------------------------------------------
    const handler = new lambda.Function(this, "ApiHandler", {
      functionName: "swarm-telemetry-handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda")),
      memorySize: 1024,
      timeout: cdk.Duration.seconds(30),
      environment: {
        BUCKET_NAME: telemetryBucket.bucketName,
        RUN_INDEX_TABLE: runIndex.tableName,
        USER_ACCESS_TABLE: userAccess.tableName,
        // Service token for GitHub API collaborator checks.
        // Set this to a GitHub PAT with repo scope after deploy:
        //   aws lambda update-function-configuration \
        //     --function-name swarm-telemetry-handler \
        //     --environment "Variables={...,GITHUB_SERVICE_TOKEN=ghp_...}"
        // Without this, collaborator auto-access is disabled and only the
        // DynamoDB allowlist is checked.
        GITHUB_SERVICE_TOKEN: process.env.GITHUB_SERVICE_TOKEN || "",
      },
      ephemeralStorageSize: cdk.Size.gibibytes(1),
    });

    // Grant Lambda access to S3 and DynamoDB
    telemetryBucket.grantReadWrite(handler);
    runIndex.grantReadWriteData(handler);
    userAccess.grantReadWriteData(handler);

    // -----------------------------------------------------------------------
    // API Gateway — user endpoints (public + GitHub OAuth for reads)
    // -----------------------------------------------------------------------
    const api = new apigateway.RestApi(this, "TelemetryApi", {
      restApiName: "swarm-telemetry-api",
      description: "Swarm telemetry upload and query API",
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    const lambdaIntegration = new apigateway.LambdaIntegration(handler);

    // POST /upload-url — get a presigned S3 PUT URL (lightweight auth)
    const uploadUrl = api.root.addResource("upload-url");
    uploadUrl.addMethod("POST", lambdaIntegration);

    // GET /runs — list runs (requires GitHub token)
    const runs = api.root.addResource("runs");
    runs.addMethod("GET", lambdaIntegration);

    // GET /runs/{runId} — get run detail + download URL
    const runDetail = runs.addResource("{runId}");
    runDetail.addMethod("GET", lambdaIntegration);

    // GET /runs/{runId}/report — get grade report JSON
    const runReport = runDetail.addResource("report");
    runReport.addMethod("GET", lambdaIntegration);

    // -----------------------------------------------------------------------
    // API Gateway — admin endpoints (IAM auth only)
    // -----------------------------------------------------------------------
    const admin = api.root.addResource("admin");

    // IAM authorization for all admin endpoints
    const iamMethodOptions: apigateway.MethodOptions = {
      authorizationType: apigateway.AuthorizationType.IAM,
    };

    // PUT /admin/allowlist — add/remove users
    const allowlist = admin.addResource("allowlist");
    allowlist.addMethod("PUT", lambdaIntegration, iamMethodOptions);
    allowlist.addMethod("GET", lambdaIntegration, iamMethodOptions);

    // DELETE /admin/runs/{runId} — delete a run
    const adminRuns = admin.addResource("runs");
    const adminRunDetail = adminRuns.addResource("{runId}");
    adminRunDetail.addMethod("DELETE", lambdaIntegration, iamMethodOptions);

    // GET /admin/stats — aggregate stats
    const adminStats = admin.addResource("stats");
    adminStats.addMethod("GET", lambdaIntegration, iamMethodOptions);

    // GET /admin/runs — list all runs (no allowlist filter)
    adminRuns.addMethod("GET", lambdaIntegration, iamMethodOptions);

    // -----------------------------------------------------------------------
    // Outputs
    // -----------------------------------------------------------------------
    new cdk.CfnOutput(this, "ApiUrl", {
      value: api.url,
      description: "API Gateway URL: set DEFAULT_TELEMETRY_ENDPOINT (packages/telemetry/src/telemetry/endpoint.ts) and the dashboard's VITE_TELEMETRY_ENDPOINT to it",
    });

    new cdk.CfnOutput(this, "BucketName", {
      value: telemetryBucket.bucketName,
      description: "S3 bucket for telemetry tarballs",
    });
  }
}
