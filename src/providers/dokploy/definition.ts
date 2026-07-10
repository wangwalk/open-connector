import type { ProviderDefinition } from "../../core/types.ts";

import { dokployActions } from "./actions.ts";

const service = "dokploy";

export const provider: ProviderDefinition = {
  service,
  displayName: "Dokploy",
  description: "Read-only access to self-hosted Dokploy projects, services, deployments, and runtime status.",
  categories: ["Developer Tools", "IT & Operations"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "Dokploy API/CLI Key",
      placeholder: "dokploy_api_key",
      description:
        "Dedicated Dokploy API/CLI key sent in the x-api-key header. Use a minimally privileged user where available.",
      extraFields: [
        {
          key: "apiBaseUrl",
          label: "Dokploy API URL",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "http://127.0.0.1:3000/api",
          description:
            "Dokploy instance URL with or without the /api suffix. Prefer loopback when OpenConnector is colocated.",
        },
      ],
    },
  ],
  homepageUrl: "https://dokploy.com",
  actions: dokployActions,
};
