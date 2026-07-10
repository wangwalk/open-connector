import type {
  CredentialValidationResult,
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
} from "../../core/types.ts";
import type { BeszelContext } from "./runtime.ts";

import { defineProviderExecutors, ProviderRequestError } from "../provider-runtime.ts";
import {
  beszelActionHandlers,
  buildBeszelValidationResult,
  loginBeszel,
  normalizeBeszelBaseUrl,
  validateBeszelToken,
} from "./runtime.ts";

const service = "beszel";

export const executors: ProviderExecutors = defineProviderExecutors<BeszelContext>({
  service,
  handlers: beszelActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<BeszelContext> {
    const credential = await context.getCredential(service);
    if (credential?.authType === "custom_credential") {
      const login = await loginBeszel(
        credential.values.baseUrl,
        credential.values.email,
        credential.values.password,
        fetcher,
        context.signal,
      );
      return { baseUrl: login.baseUrl, token: login.token, fetcher, signal: context.signal };
    }
    if (credential?.authType === "api_key") {
      return {
        baseUrl: normalizeBeszelBaseUrl(credential.values.baseUrl ?? credential.metadata.baseUrl),
        token: credential.apiKey,
        fetcher,
        signal: context.signal,
      };
    }
    throw new ProviderRequestError(401, "Configure Beszel readonly credentials first.");
  },
});

export const credentialValidators: CredentialValidators = {
  async customCredential(input, { fetcher, signal }): Promise<CredentialValidationResult> {
    const login = await loginBeszel(input.values.baseUrl, input.values.email, input.values.password, fetcher, signal);
    return buildBeszelValidationResult(login.user, login.baseUrl);
  },
  apiKey(input, { fetcher, signal }) {
    return validateBeszelToken(input.values.baseUrl, input.apiKey, fetcher, signal);
  },
};
