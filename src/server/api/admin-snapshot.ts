import type { CatalogStore } from "../../catalog-store.ts";
import type { ConnectionService, ConnectionSummary } from "../../connection-service.ts";
import type { ProviderDefinition } from "../../core/types.ts";
import type { OAuthClientConfigService, OAuthClientConfigSummary } from "../../oauth/oauth-client-config-service.ts";
import type { ActionRunner } from "../actions/action-runner.ts";
import type { RunLogPage } from "../storage/runtime-store.ts";
import type { RuntimeTokenService, RuntimeTokenSummary } from "../storage/runtime-token-service.ts";
import type { LocalAuthOptions, LocalAuthSession } from "./auth.ts";
import type { Context } from "hono";

import { readLocalAuthSession } from "./auth.ts";

/** Data required to render the local administration overview in one request. */
export interface AdminSnapshot {
  authSession: LocalAuthSession;
  providers: ProviderDefinition[];
  connections: ConnectionSummary[];
  oauthConfigs: OAuthClientConfigSummary[];
  runtimeTokens: RuntimeTokenSummary[];
  runs: RunLogPage;
  healthOk: boolean;
}

export interface CreateAdminSnapshotOptions {
  catalog: CatalogStore;
  connections: ConnectionService;
  oauthClientConfigs: OAuthClientConfigService;
  runtimeTokens: RuntimeTokenService;
  actions: ActionRunner;
  auth: LocalAuthOptions;
}

/** Read a consistent administration overview without routing through HTTP internally. */
export async function createAdminSnapshot(
  context: Context,
  options: CreateAdminSnapshotOptions,
): Promise<AdminSnapshot> {
  const [authSession, connections, oauthConfigs, runtimeTokens, runs] = await Promise.all([
    readLocalAuthSession(context, options.auth),
    options.connections.listConnections(),
    options.oauthClientConfigs.listConfigs(),
    options.runtimeTokens.listTokens(),
    options.actions.listRuns(),
  ]);

  return {
    authSession,
    providers: options.catalog.providers,
    connections,
    oauthConfigs,
    runtimeTokens,
    runs,
    healthOk: true,
  };
}
