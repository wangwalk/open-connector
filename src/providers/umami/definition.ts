import type { ProviderDefinition } from "../../core/types.ts";

import { umamiActions } from "./actions.ts";

const service = "umami";

export const provider: ProviderDefinition = {
  service,
  displayName: "Umami",
  categories: ["Data", "Marketing"],
  authTypes: ["api_key", "custom_credential"],
  auth: [
    {
      type: "api_key",
      label: "API Key or Bearer Token",
      placeholder: "umami_api_key_or_token",
      description: "Umami Cloud API key, or a self-hosted Bearer token. Leave the API base URL empty for Umami Cloud.",
      extraFields: [
        {
          key: "apiBaseUrl",
          label: "Self-hosted Umami URL",
          inputType: "text",
          required: false,
          secret: false,
          placeholder: "https://analytics.example.com",
          description:
            "Optional self-hosted Umami instance URL. Do not include credentials, query parameters, or fragments.",
        },
      ],
    },
    {
      type: "custom_credential",
      fields: [
        {
          key: "baseUrl",
          label: "Self-hosted Umami URL",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "https://analytics.example.com",
          description: "Self-hosted Umami instance URL. The provider appends the /api path.",
        },
        {
          key: "username",
          label: "Username",
          inputType: "text",
          required: true,
          secret: false,
          description: "Username for a dedicated, minimally privileged Umami account.",
        },
        {
          key: "password",
          label: "Password",
          inputType: "password",
          required: true,
          secret: true,
          description: "Password for the dedicated Umami account. It is stored in the encrypted credential store.",
        },
      ],
      testAction: {
        actionName: "get_current_user",
        input: {},
      },
    },
  ],
  homepageUrl: "https://umami.is",
  actions: umamiActions,
};
