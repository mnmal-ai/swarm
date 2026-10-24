// Shared state for the AWS SDK fakes: every command sent to DynamoDB is
// recorded, and a test decides what DynamoDB answers. Nothing reaches AWS.

export const sent = [];

let reply = () => ({});

/** Set what DynamoDB answers each command with. */
export function setDdbReply(fn) {
  reply = fn;
}

export function reset() {
  sent.length = 0;
  reply = () => ({});
}

export function ddbSend(cmd) {
  sent.push(cmd);
  return reply(cmd);
}

/** A command class that keeps its name and input, like the SDK's. */
export function command(name) {
  return class {
    constructor(input) {
      this.name = name;
      this.input = input;
    }
  };
}
