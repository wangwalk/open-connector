import type { ProviderActionDefinition } from "../../core/provider-definition.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "dokploy";
const idSchema = s.nonEmptyString("Dokploy resource ID.");
const pageLimitSchema = s.integer("Maximum number of search results.", { minimum: 1, maximum: 100 });
const offsetSchema = s.nonNegativeInteger("Search result offset.");
const serviceTypeValues = ["application", "compose", "postgres", "mysql", "mariadb", "mongo", "redis"];

const projectSchema = s.requiredObject("Safe Dokploy project summary.", {
  id: s.string("Project ID."),
  name: s.string("Project name."),
  description: s.nullableString("Project description."),
  createdAt: s.nullableString("Creation timestamp."),
  updatedAt: s.nullableString("Last update timestamp."),
  environments: s.array(
    "Environment summaries.",
    s.requiredObject("Safe environment summary.", {
      id: s.string("Environment ID."),
      name: s.string("Environment name."),
      description: s.nullableString("Environment description."),
      createdAt: s.nullableString("Creation timestamp."),
    }),
  ),
});

const applicationSchema = s.requiredObject("Safe Dokploy application summary.", {
  id: s.string("Application ID."),
  name: s.string("Application display name."),
  appName: s.nullableString("Dokploy application runtime name."),
  description: s.nullableString("Application description."),
  status: s.nullableString("Configured application status."),
  sourceType: s.nullableString("Application source type."),
  repository: s.nullableString("Repository name or URL."),
  branch: s.nullableString("Configured source branch."),
  dockerImage: s.nullableString("Configured Docker image."),
  projectId: s.nullableString("Owning project ID."),
  environmentId: s.nullableString("Owning environment ID."),
  serverId: s.nullableString("Target server ID."),
  createdAt: s.nullableString("Creation timestamp."),
  updatedAt: s.nullableString("Last update timestamp."),
});

const serviceSchema = s.requiredObject("Safe Dokploy service summary.", {
  id: s.string("Service ID."),
  type: s.string("Service kind."),
  name: s.string("Service display name."),
  appName: s.nullableString("Dokploy runtime name."),
  status: s.nullableString("Configured service status."),
  projectId: s.nullableString("Owning project ID."),
  environmentId: s.nullableString("Owning environment ID."),
  serverId: s.nullableString("Target server ID."),
  createdAt: s.nullableString("Creation timestamp."),
  updatedAt: s.nullableString("Last update timestamp."),
});

const deploymentSchema = s.requiredObject("Safe Dokploy deployment summary.", {
  id: s.string("Deployment ID."),
  title: s.nullableString("Deployment title."),
  description: s.nullableString("Deployment description."),
  status: s.nullableString("Deployment status."),
  source: s.nullableString("Deployment source."),
  createdAt: s.nullableString("Creation timestamp."),
  startedAt: s.nullableString("Start timestamp."),
  finishedAt: s.nullableString("Finish timestamp."),
});

const containerSchema = s.requiredObject("Safe Docker container status.", {
  id: s.string("Container ID."),
  name: s.string("Container name."),
  image: s.nullableString("Container image."),
  state: s.nullableString("Container state."),
  status: s.nullableString("Human-readable container status."),
  health: s.nullableString("Container health status when available."),
  createdAt: s.nullableString("Container creation time when available."),
});

export const dokployActions: ProviderActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_projects",
    description: "List Dokploy projects and environment summaries without exposing nested service secrets.",
    inputSchema: s.actionInput({}, [], "No input is required."),
    outputSchema: s.actionOutput({ projects: s.array("Dokploy projects.", projectSchema) }),
  }),
  defineProviderAction(service, {
    name: "get_project",
    description: "Get one Dokploy project summary without exposing nested credentials or environment variables.",
    inputSchema: s.actionInput({ projectId: idSchema }, ["projectId"]),
    outputSchema: s.actionOutput({ project: projectSchema }),
  }),
  defineProviderAction(service, {
    name: "list_applications",
    description: "Search Dokploy applications and return only safe metadata.",
    inputSchema: s.actionInput({
      query: s.string("Optional free-text search."),
      projectId: s.string("Optional project ID filter."),
      environmentId: s.string("Optional environment ID filter."),
      limit: pageLimitSchema,
      offset: offsetSchema,
    }),
    outputSchema: s.actionOutput({
      applications: s.array("Dokploy applications.", applicationSchema),
      total: s.nonNegativeInteger("Total matching applications when reported."),
    }),
  }),
  defineProviderAction(service, {
    name: "list_services",
    description: "List safe summaries of applications, compose stacks, and managed databases from the project graph.",
    inputSchema: s.actionInput({
      projectId: s.string("Optional project ID filter."),
      environmentId: s.string("Optional environment ID filter."),
      type: s.stringEnum("Optional service kind filter.", serviceTypeValues),
    }),
    outputSchema: s.actionOutput({ services: s.array("Dokploy service summaries.", serviceSchema) }),
  }),
  defineProviderAction(service, {
    name: "get_application",
    description: "Get safe Dokploy application details with secrets and environment variables omitted.",
    inputSchema: s.actionInput({ applicationId: idSchema }, ["applicationId"]),
    outputSchema: s.actionOutput({ application: applicationSchema }),
  }),
  defineProviderAction(service, {
    name: "get_deployments",
    description: "List read-only deployment history for a Dokploy resource.",
    inputSchema: s.actionInput(
      {
        resourceId: idSchema,
        type: s.stringEnum("Dokploy resource type. Defaults to application.", [
          "application",
          "compose",
          "server",
          "schedule",
          "previewDeployment",
          "backup",
          "volumeBackup",
        ]),
      },
      ["resourceId"],
    ),
    outputSchema: s.actionOutput({ deployments: s.array("Deployment summaries.", deploymentSchema) }),
  }),
  defineProviderAction(service, {
    name: "get_application_status",
    description:
      "Read configured application status and actual Docker container state without returning inspect secrets.",
    inputSchema: s.actionInput({ applicationId: idSchema }, ["applicationId"]),
    outputSchema: s.actionOutput({
      application: applicationSchema,
      containers: s.array("Safe runtime container states.", containerSchema),
    }),
  }),
];

export type DokployActionName = (typeof dokployActions)[number]["name"];
