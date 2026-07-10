import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";
import type { DokployContext } from "./runtime.ts";

import { defineProviderExecutors, ProviderRequestError } from "../provider-runtime.ts";
import { dokployActionHandlers, normalizeDokployApiBaseUrl, validateDokployCredential } from "./runtime.ts";

const service = "dokploy";

export const executors: ProviderExecutors = defineProviderExecutors<DokployContext>({
  service,
  handlers: dokployActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<DokployContext> {
    const credential = await context.getCredential(service);
    if (credential?.authType !== "api_key") {
      throw new ProviderRequestError(401, "Configure a Dokploy API/CLI key first.");
    }
    return {
      apiBaseUrl: normalizeDokployApiBaseUrl(credential.values.apiBaseUrl ?? credential.metadata.apiBaseUrl),
      apiKey: credential.apiKey,
      fetcher,
      signal: context.signal,
    };
  },
});

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher, signal }) {
    return validateDokployCredential(input.values.apiBaseUrl, input.apiKey, fetcher, signal);
  },
};
