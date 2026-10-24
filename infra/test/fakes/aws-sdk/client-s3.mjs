// Stand-in for @aws-sdk/client-s3 in tests (see jest.config.js).
import { command } from "./recorder.mjs";

export class S3Client {
  async send() {
    return { Contents: [] };
  }
}
export const PutObjectCommand = command("s3:PutObject");
export const GetObjectCommand = command("s3:GetObject");
export const DeleteObjectCommand = command("s3:DeleteObject");
export const ListObjectsV2Command = command("s3:ListObjectsV2");
