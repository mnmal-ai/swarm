import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import { InfraStack } from "../lib/infra-stack";

// Synthesises the stack in memory: nothing here reaches AWS.
const template = Template.fromStack(new InfraStack(new cdk.App(), "TestStack"));

describe("InfraStack resource names", () => {
  test("the telemetry bucket is swarm-telemetry-<account>", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: { "Fn::Join": ["", ["swarm-telemetry-", { Ref: "AWS::AccountId" }]] },
    });
  });

  test("the run index and user access tables", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", { TableName: "swarm-run-index" });
    template.hasResourceProperties("AWS::DynamoDB::Table", { TableName: "swarm-user-access" });
    template.resourceCountIs("AWS::DynamoDB::Table", 2);
  });

  test("the Lambda handler", () => {
    template.hasResourceProperties("AWS::Lambda::Function", { FunctionName: "swarm-telemetry-handler" });
  });

  test("the REST API", () => {
    template.hasResourceProperties("AWS::ApiGateway::RestApi", { Name: "swarm-telemetry-api" });
  });

  test("no literal AWS account id in the template", () => {
    expect(JSON.stringify(template.toJSON())).not.toMatch(/\b\d{12}\b/);
  });
});
