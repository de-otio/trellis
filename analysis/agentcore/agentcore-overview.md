# AWS Bedrock AgentCore: Overview for Trellis

## What is AgentCore?

Amazon Bedrock AgentCore is a modular platform for building, deploying, and operating AI agents on AWS. It provides nine managed services that can be used independently or together:

| Service | Purpose |
|---------|---------|
| **Runtime** | Serverless execution environment with session isolation, fast cold starts, and support for async agents |
| **Memory** | Short-term (conversation) and long-term (cross-session) memory with sharing across agents |
| **Gateway** | Expose APIs, Lambda functions, and services as MCP-compatible tools; includes pre-built connectors (Slack, JIRA, Salesforce) |
| **Identity** | Agent authentication and access control, compatible with Cognito, Okta, Entra ID |
| **Code Interpreter** | Sandboxed execution of Python, JavaScript, TypeScript |
| **Browser** | Cloud-based browser for web interaction and data extraction |
| **Observability** | OpenTelemetry-compatible tracing, debugging, and monitoring |
| **Evaluations** | Automated quality assessment across 13 dimensions (correctness, safety, tool selection) |
| **Policy** | Deterministic business rules in natural language or Cedar; enforced at the Gateway layer |

## Key Protocols

- **MCP (Model Context Protocol)**: Connects agents to tools and data sources. AgentCore Gateway natively speaks MCP.
- **A2A (Agent-to-Agent)**: Enables multi-agent coordination via JSON-RPC 2.0 over HTTP. Agents discover peers, share capabilities, and coordinate actions across frameworks.

## Why AgentCore for Trellis?

Trellis already runs entirely on AWS (ECS Fargate, Lambda, Cognito, RDS, DynamoDB, SQS, CloudFront). AgentCore integrates natively with this stack:

- **Cognito** is directly supported by AgentCore Identity
- **Lambda functions** can be exposed as agent tools via Gateway
- **SQS queues** can trigger agent workflows
- **CloudWatch/X-Ray** integrate with AgentCore Observability
- **CDK** can provision AgentCore resources (CloudFormation support is GA)

The consumption-based pricing model (no minimums) makes it viable for a single-developer project where agent usage is intermittent.

## Framework Flexibility

AgentCore Runtime supports agents built with any framework: Strands Agents, LangGraph, CrewAI, LlamaIndex, Google ADK, OpenAI Agents SDK, or custom code. This avoids vendor lock-in on the agent logic while leveraging AWS for infrastructure.
