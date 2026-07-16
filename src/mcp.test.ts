import type { IConnectionStore, StoredConnection } from "./connection-service.ts";
import type { ActionDefinition, ActionExecutor, ProviderDefinition, ResolvedCredential } from "./core/types.ts";
import type { IProviderLoader } from "./providers/provider-loader.ts";
import type { IRunLogStore, RunLogPage } from "./server/storage/runtime-store.ts";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createCatalogStore } from "./catalog-store.ts";
import { ConnectionService } from "./connection-service.ts";
import { createMcpServer } from "./mcp.ts";
import { ActionRunner } from "./server/actions/action-runner.ts";

const echoAction: ActionDefinition = {
  id: "example.echo",
  service: "example",
  name: "echo",
  description: "Echo input.",
  requiredScopes: [],
  providerPermissions: [],
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string" },
    },
    required: ["message"],
    additionalProperties: false,
  },
  outputSchema: { type: "object" },
};

const exampleProvider: ProviderDefinition = {
  service: "example",
  displayName: "Example",
  categories: ["Developer Tools"],
  authTypes: ["no_auth"],
  auth: [{ type: "no_auth" }],
  actions: [echoAction],
};

const secureEchoAction: ActionDefinition = {
  ...echoAction,
  id: "secure.echo",
  service: "secure",
};

const secureProvider: ProviderDefinition = {
  service: "secure",
  displayName: "Secure",
  categories: ["Developer Tools"],
  authTypes: ["api_key"],
  auth: [{ type: "api_key" }],
  actions: [secureEchoAction],
};

describe("MCP server", () => {
  it("lists the discovery tools through the MCP protocol", async () => {
    await withMcpClient(async (client) => {
      const result = await client.listTools();

      expect(result.tools.map((tool) => tool.name)).toEqual([
        "list_apps",
        "search_actions",
        "get_action_guide",
        "execute_action",
      ]);
    });
  });

  it("publishes server instructions through MCP initialization", async () => {
    await withMcpClient(async (client) => {
      const instructions = client.getInstructions();

      expect(instructions).toBeTypeOf("string");
      expect(instructions).toContain("Start with list_apps or search_actions.");
      expect(instructions).toContain("Call get_action_guide before execute_action");
    });
  });

  it("returns structured content for action search and execution", async () => {
    await withMcpClient(async (client) => {
      const search = await client.callTool({
        name: "search_actions",
        arguments: { query: "echo", limit: 1 },
      });
      const run = await client.callTool({
        name: "execute_action",
        arguments: { actionId: "example.echo", input: { message: "hello" } },
      });

      expect(search.isError).toBeUndefined();
      expect(search.structuredContent).toMatchObject({
        ok: true,
        data: [
          {
            id: "example.echo",
            service: "example",
          },
        ],
      });
      expect(run.isError).toBeUndefined();
      expect(run.structuredContent).toEqual({
        ok: true,
        data: {
          message: "hello",
        },
      });
    });
  });

  it("marks action execution failures as MCP tool errors", async () => {
    await withMcpClient(async (client) => {
      const result = await client.callTool({
        name: "execute_action",
        arguments: { actionId: "example.echo", input: {} },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: {
          code: "invalid_input",
          message: "Action input does not match the action schema.",
        },
      });
    });
  });

  it("marks unknown action guides as MCP tool errors", async () => {
    await withMcpClient(async (client) => {
      const result = await client.callTool({
        name: "get_action_guide",
        arguments: { actionId: "example.missing" },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        ok: false,
        error: {
          code: "unknown_action",
          message: "Unknown action: example.missing",
        },
      });
    });
  });

  it("lists named accounts and routes execution through an explicit connection", async () => {
    await withMcpClient(
      async (client) => {
        const apps = await client.callTool({ name: "list_apps", arguments: { query: "secure" } });
        const guide = await client.callTool({
          name: "get_action_guide",
          arguments: { actionId: "secure.echo", connectionName: "dollify" },
        });
        const run = await client.callTool({
          name: "execute_action",
          arguments: { actionId: "secure.echo", connectionName: "dollify", input: { message: "hello" } },
        });

        expect(apps.structuredContent).toMatchObject({
          ok: true,
          data: [
            {
              service: "secure",
              connectionCount: 2,
              connection: { connectionName: "default" },
              connections: [{ connectionName: "default" }, { connectionName: "dollify" }],
            },
          ],
        });
        expect(guide.structuredContent).toMatchObject({
          ok: true,
          data: {
            capability: {
              connection: { connectionName: "dollify" },
              connections: [{ connectionName: "default" }, { connectionName: "dollify" }],
            },
            markdown: expect.stringContaining("Connection `dollify` (selected)"),
          },
        });
        expect(run.structuredContent).toEqual({
          ok: true,
          data: { message: "hello", selectedAccount: "dollify-account" },
        });
      },
      { providers: [secureProvider], storedConnections: secureConnections },
    );
  });

  it("rejects ambiguous execution and unknown explicit connections", async () => {
    await withMcpClient(
      async (client) => {
        const ambiguous = await client.callTool({
          name: "execute_action",
          arguments: { actionId: "secure.echo", input: { message: "hello" } },
        });
        const missing = await client.callTool({
          name: "execute_action",
          arguments: { actionId: "secure.echo", connectionName: "missing", input: { message: "hello" } },
        });

        expect(ambiguous.isError).toBe(true);
        expect(ambiguous.structuredContent).toMatchObject({
          ok: false,
          error: {
            code: "ambiguous_connection",
            details: {
              service: "secure",
              connections: [{ connectionName: "default" }, { connectionName: "dollify" }],
            },
          },
        });
        expect(missing.isError).toBe(true);
        expect(missing.structuredContent).toMatchObject({
          ok: false,
          error: { code: "connection_not_found" },
        });
      },
      { providers: [secureProvider], storedConnections: secureConnections },
    );
  });
});

interface McpFixture {
  providers?: ProviderDefinition[];
  storedConnections?: StoredConnection[];
}

async function withMcpClient(run: (client: Client) => Promise<void>, fixture: McpFixture = {}): Promise<void> {
  const providers = fixture.providers ?? [exampleProvider];
  const catalog = createCatalogStore(providers, {
    executableActionIds: providers.flatMap((provider) => provider.actions.map((action) => action.id)),
  });
  const providerLoader = new EchoProviderLoader();
  const connections = new ConnectionService({
    catalog,
    providerLoader,
    store: new MemoryConnectionStore(fixture.storedConnections),
  });
  const actions = new ActionRunner({
    catalog,
    providerLoader,
    connections,
    runs: new MemoryRunLogStore(),
  });
  const server = createMcpServer({
    catalog,
    providerLoader,
    connections,
    actions,
  });
  const client = new Client({ name: "mcp-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

class EchoProviderLoader implements IProviderLoader {
  async loadActionExecutor(service: string): Promise<ActionExecutor> {
    return async (input, context) => {
      const credential = await context.getCredential(service);
      const selectedAccount = credential && "profile" in credential ? credential.profile.accountId : undefined;
      return {
        ok: true,
        output: selectedAccount ? { ...(input as Record<string, unknown>), selectedAccount } : input,
      };
    };
  }

  async loadProxyExecutor(): Promise<undefined> {
    return undefined;
  }

  async loadCredentialValidators(): Promise<undefined> {
    return undefined;
  }
}

class MemoryConnectionStore implements IConnectionStore {
  private readonly connections: StoredConnection[];

  constructor(connections: StoredConnection[] = []) {
    this.connections = connections;
  }

  async get(service: string, connectionName: string): Promise<ResolvedCredential | undefined> {
    return this.connections.find(
      (connection) => connection.service === service && connection.connectionName === connectionName,
    )?.credential;
  }

  async set(service: string, connectionName: string, credential: ResolvedCredential): Promise<void> {
    const index = this.connections.findIndex(
      (connection) => connection.service === service && connection.connectionName === connectionName,
    );
    const stored = { service, connectionName, credential };
    if (index >= 0) this.connections[index] = stored;
    else this.connections.push(stored);
  }

  async delete(service: string, connectionName: string): Promise<void> {
    const index = this.connections.findIndex(
      (connection) => connection.service === service && connection.connectionName === connectionName,
    );
    if (index >= 0) this.connections.splice(index, 1);
  }

  async list(): Promise<StoredConnection[]> {
    return this.connections;
  }
}

const secureConnections: StoredConnection[] = [
  secureConnection("default", "personal-account", "Personal"),
  secureConnection("dollify", "dollify-account", "Dollify"),
];

function secureConnection(connectionName: string, accountId: string, displayName: string): StoredConnection {
  return {
    service: "secure",
    connectionName,
    credential: {
      authType: "api_key",
      apiKey: `${connectionName}-secret`,
      values: { apiKey: `${connectionName}-secret` },
      profile: { accountId, displayName, grantedScopes: [] },
      metadata: {},
    },
  };
}

class MemoryRunLogStore implements IRunLogStore {
  async add(): Promise<void> {}

  async list(): Promise<RunLogPage> {
    return { items: [] };
  }
}
