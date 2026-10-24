// Stand-in for @aws-sdk/lib-dynamodb in tests (see jest.config.js).
import { command, ddbSend } from "./recorder.mjs";

export const DynamoDBDocumentClient = {
  from: () => ({ send: async (cmd) => ddbSend(cmd) }),
};
export const PutCommand = command("ddb:Put");
export const GetCommand = command("ddb:Get");
export const DeleteCommand = command("ddb:Delete");
export const QueryCommand = command("ddb:Query");
export const ScanCommand = command("ddb:Scan");
