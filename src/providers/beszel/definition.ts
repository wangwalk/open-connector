import type { ProviderDefinition } from "../../core/types.ts";

import { beszelActions } from "./actions.ts";

const service = "beszel";

export const provider: ProviderDefinition = {
  service,
  displayName: "Beszel",
  description: "Read-only access to self-hosted Beszel systems, containers, and monitoring metrics.",
  categories: ["Developer Tools", "IT & Operations"],
  authTypes: ["custom_credential", "api_key"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "baseUrl",
          label: "Beszel Hub URL",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "https://beszel.example.com",
          description: "URL of the Beszel Hub. Create a dedicated readonly user for this connection.",
        },
        {
          key: "email",
          label: "Email",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "openconnector@example.com",
          description: "Email address of a dedicated Beszel readonly user.",
        },
        {
          key: "password",
          label: "Password",
          inputType: "password",
          required: true,
          secret: true,
          description: "Password for the dedicated readonly user. It is stored in the encrypted credential store.",
        },
      ],
      testAction: {
        actionName: "list_systems",
        input: { pageSize: 1 },
      },
    },
    {
      type: "api_key",
      label: "PocketBase Auth Token",
      placeholder: "eyJhbGciOiJIUzI1NiIs...",
      description: "PocketBase user token fallback for installations where password login is disabled.",
      extraFields: [
        {
          key: "baseUrl",
          label: "Beszel Hub URL",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "https://beszel.example.com",
          description: "URL of the Beszel Hub.",
        },
      ],
    },
  ],
  homepageUrl: "https://beszel.dev",
  actions: beszelActions,
};
