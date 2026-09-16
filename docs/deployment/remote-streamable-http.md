# Remote Streamable HTTP

The maintained remote deployment for Qlik MCP is
[Amazon Bedrock AgentCore Runtime](amazon-bedrock-agentcore.md). It uses stateless
Streamable HTTP at the container `/mcp` route, platform session headers, per-request
JWT identity, durable DynamoDB workflow state, and Secrets Manager credentials.

Use the AWS invocation endpoint and exact runtime version described in that
runbook. The container health route is not a separate public invocation URL.
The application package starts AgentCore with `npm start`.

Local STDIO and standalone HTTP source remain useful for development and
provider integration tests. They do not establish an independently supported
hosted deployment with equivalent identity, secret, distributed-state, network,
or operational controls. Never expose fixture development mode publicly.

[Provider client examples](provider-remote-mcp-examples.md) are illustrative
configuration shapes. Validate each real client's protocol, token audience,
scopes, headers, error behavior, and retention policy against the reviewed
endpoint before enabling writes.
