# Azure hosting reference

Azure Container Apps is not a maintained deployment lane for this release
candidate. Earlier upstream design documents and deployment state are not
acceptance evidence for Qlik MCP. Use the
[AgentCore deployment runbook](amazon-bedrock-agentcore.md) for the supported
hosting architecture.

Some provider-neutral transport, identity, and adapter code is retained. An Azure
port would require independently implemented and validated infrastructure,
secret injection, audience/issuer enforcement, durable multi-instance workflow
state, networking, capacity, telemetry, and recovery. It must not reuse local
file stores as a distributed transaction boundary or infer readiness from
AgentCore tests. No Azure deployment command is prescribed by this repository.
