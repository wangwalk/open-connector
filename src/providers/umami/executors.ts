import type {
  CredentialValidationResult,
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
} from "../../core/types.ts";
import type { UmamiProviderContext } from "./runtime.ts";

import { requiredString } from "../../core/cast.ts";
import { defineProviderExecutors, ProviderRequestError } from "../provider-runtime.ts";
import {
  buildUmamiValidationResult,
  loginUmami,
  normalizeUmamiApiBaseUrl,
  umamiActionHandlers,
  validateUmamiCredential,
} from "./runtime.ts";

const service = "umami";
const credentialError = (message: string): ProviderRequestError => new ProviderRequestError(400, message);

export const executors: ProviderExecutors = defineProviderExecutors<UmamiProviderContext>({
  service,
  handlers: umamiActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<UmamiProviderContext> {
    const credential = await context.getCredential(service);
    if (credential?.authType === "api_key") {
      return {
        apiBaseUrl: normalizeUmamiApiBaseUrl(credential.values.apiBaseUrl ?? credential.metadata.apiBaseUrl),
        accessToken: credential.apiKey,
        fetcher,
        signal: context.signal,
      };
    }
    if (credential?.authType === "custom_credential") {
      const login = await loginUmami(
        requiredString(credential.values.baseUrl, "baseUrl", credentialError),
        requiredString(credential.values.username, "username", credentialError),
        requiredString(credential.values.password, "password", credentialError),
        fetcher,
        context.signal,
      );
      return {
        apiBaseUrl: login.apiBaseUrl,
        accessToken: login.accessToken,
        fetcher,
        signal: context.signal,
      };
    }
    throw new ProviderRequestError(401, "Configure Umami API key or self-hosted credentials first.");
  },
});

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher, signal }) {
    const apiBaseUrl = normalizeUmamiApiBaseUrl(input.values.apiBaseUrl);
    return validateUmamiCredential(input.apiKey, apiBaseUrl, fetcher, signal);
  },
  async customCredential(input, { fetcher, signal }): Promise<CredentialValidationResult> {
    const login = await loginUmami(
      requiredString(input.values.baseUrl, "baseUrl", credentialError),
      requiredString(input.values.username, "username", credentialError),
      requiredString(input.values.password, "password", credentialError),
      fetcher,
      signal,
    );
    return buildUmamiValidationResult(login.user, login.apiBaseUrl);
  },
};
