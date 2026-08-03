import express, { type Express, type NextFunction, type Request, type Response } from "express";
import {
  ManagedToolSchema,
  PromptArgumentSchema,
  PromptDefinitionSchema,
  PromptMessageSchema,
} from "@open-agent-tools/mcp-contracts";
import { z, ZodError } from "zod";
import { ArtifactUploadError, type ArtifactUploadService } from "./artifact-upload.js";
import type { AuditService } from "./audit.js";
import type { ArtifactBuildQueue } from "./build-queue.js";
import type { ClientAccessService } from "./client-access.js";
import type { McpScope } from "./client-access-repository.js";
import { ManagementError, type McpManagementService } from "./management.js";
import type { Actor } from "./types.js";

export interface ControlPlaneAppOptions {
  management: McpManagementService;
  artifactUploads?: ArtifactUploadService;
  buildQueue?: ArtifactBuildQueue;
  clientAccess?: ClientAccessService;
  audit?: AuditService;
  authenticate?: (request: Request) => Actor | null | Promise<Actor | null>;
}

const ANONYMOUS_ADMIN_ACTOR = Object.freeze({ id: "anonymous", role: "admin" } satisfies Actor);

const ExpectedRevisionSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
const UpdateServiceBodySchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    name: z.string().optional(),
    slug: z.string().optional(),
  })
  .strict();
const ToolPatchSchema = ManagedToolSchema.partial().strict();
const PromptPatchSchema = z
  .object({
    name: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    arguments: z.array(PromptArgumentSchema).optional(),
    messages: z.array(PromptMessageSchema).optional(),
  })
  .strict();
const AddToolBodySchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    tool: ManagedToolSchema,
  })
  .strict();
const UpdateToolBodySchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    tool: ToolPatchSchema,
  })
  .strict();
const AddPromptBodySchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    prompt: PromptDefinitionSchema,
  })
  .strict();
const UpdatePromptBodySchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    prompt: PromptPatchSchema,
  })
  .strict();
const PreviewPromptBodySchema = z
  .object({ arguments: z.record(z.string(), z.string()).default({}) })
  .strict();
const ListLimitSchema = z.coerce.number().int().min(1).max(200).default(100);
const AuditQuerySchema = z.object({
  limit: ListLimitSchema,
  outcome: z.enum(["SUCCEEDED", "FAILED"]).optional(),
  action: z.string().trim().min(1).max(120).optional(),
});

function actorFrom(response: Response): Actor {
  return response.locals.actor as Actor;
}

function statusForError(error: ManagementError): number {
  switch (error.code) {
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
    case "IMMUTABLE_VERSION":
    case "INVALID_STATE":
      return 409;
    case "VALIDATION_ERROR":
      return 400;
  }
}

export function createControlPlaneApp(options: ControlPlaneAppOptions): Express {
  const app = express();
  const { management } = options;
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.use("/api/admin/mcp", async (request, response, next) => {
    try {
      const actor = options.authenticate
        ? await options.authenticate(request)
        : ANONYMOUS_ADMIN_ACTOR;
      if (!actor) {
        response.status(401).json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
        return;
      }
      response.locals.actor = actor;
      next();
    } catch (error) {
      next(error);
    }
  });

  if (options.audit) {
    app.use("/api/admin/mcp", (request, response, next) => {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        const startedAt = Date.now();
        response.once("finish", () => {
          const route = String(request.route?.path ?? request.path);
          void options.audit!.recordHttp({
            actor: actorFrom(response),
            method: request.method,
            route,
            target: request.originalUrl.split("?", 1)[0] ?? request.originalUrl,
            requestId: request.header("x-request-id"),
            statusCode: response.statusCode,
            durationMs: Date.now() - startedAt,
          });
        });
      }
      next();
    });
  }

  async function assertRouteVersion(request: Request, actor: Actor) {
    const versionId = request.params.versionId as string;
    const serviceId = request.params.serviceId as string;
    const version = await management.getVersion(versionId, actor);
    if (version.serviceId !== serviceId) {
      throw new ManagementError("NOT_FOUND", `Version not found: ${versionId}`);
    }
    return version;
  }

  app.get("/api/admin/mcp/services", async (_request, response) => {
    response.json({ services: await management.listServices(actorFrom(response)) });
  });

  app.get("/api/admin/mcp/builds", async (request, response) => {
    const limit = ListLimitSchema.parse(request.query.limit);
    response.json({ builds: await management.listBuildJobs(limit, actorFrom(response)) });
  });

  if (options.audit) {
    app.get("/api/admin/mcp/audit", async (request, response) => {
      const query = AuditQuerySchema.parse(request.query);
      response.json({ events: await options.audit!.list(query, actorFrom(response)) });
    });
  }

  app.post("/api/admin/mcp/services", async (request, response) => {
    const body = request.body as { name?: string; slug?: string; type?: string };
    if (body.type !== "MANAGED_MCP") {
      throw new ManagementError(
        "VALIDATION_ERROR",
        "This endpoint currently requires type MANAGED_MCP",
      );
    }
    const created = await management.createManagedService(
      { name: body.name ?? "", slug: body.slug ?? "" },
      actorFrom(response),
    );
    response.status(201).json(created);
  });

  app.get("/api/admin/mcp/services/:serviceId", async (request, response) => {
    response.json({
      service: await management.getService(request.params.serviceId as string, actorFrom(response)),
    });
  });

  app.patch("/api/admin/mcp/services/:serviceId", async (request, response) => {
    const body = UpdateServiceBodySchema.parse(request.body);
    response.json({
      service: await management.updateService(
        request.params.serviceId as string,
        {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.slug === undefined ? {} : { slug: body.slug }),
        },
        body.expectedRevision,
        actorFrom(response),
      ),
    });
  });

  app.delete("/api/admin/mcp/services/:serviceId", async (request, response) => {
    const body = ExpectedRevisionSchema.parse(request.body);
    await management.deleteService(
      request.params.serviceId as string,
      body.expectedRevision,
      actorFrom(response),
    );
    response.status(204).end();
  });

  app.post("/api/admin/mcp/services/:serviceId/disable", async (request, response) => {
    const body = ExpectedRevisionSchema.parse(request.body);
    response.json({
      service: await management.disableService(
        request.params.serviceId as string,
        body.expectedRevision,
        actorFrom(response),
      ),
    });
  });

  app.post("/api/admin/mcp/services/:serviceId/enable", async (request, response) => {
    const body = ExpectedRevisionSchema.parse(request.body);
    response.json({
      service: await management.enableService(
        request.params.serviceId as string,
        body.expectedRevision,
        actorFrom(response),
      ),
    });
  });

  app.get("/api/admin/mcp/services/:serviceId/versions", async (request, response) => {
    response.json({
      versions: await management.listVersions(
        request.params.serviceId as string,
        actorFrom(response),
      ),
    });
  });

  app.get(
    "/api/admin/mcp/services/:serviceId/versions/:versionId/tools",
    async (request, response) => {
      const version = await assertRouteVersion(request, actorFrom(response));
      response.json({ tools: version.tools, revision: version.revision });
    },
  );

  app.post(
    "/api/admin/mcp/services/:serviceId/versions/:versionId/tools",
    async (request, response) => {
      await assertRouteVersion(request, actorFrom(response));
      const body = AddToolBodySchema.parse(request.body);
      const version = await management.addTool(
        request.params.versionId as string,
        body.tool,
        body.expectedRevision,
        actorFrom(response),
      );
      response.status(201).json({ version });
    },
  );

  app.patch(
    "/api/admin/mcp/services/:serviceId/versions/:versionId/tools/:toolId",
    async (request, response) => {
      await assertRouteVersion(request, actorFrom(response));
      const body = UpdateToolBodySchema.parse(request.body);
      response.json({
        version: await management.updateTool(
          request.params.versionId as string,
          request.params.toolId as string,
          body.tool,
          body.expectedRevision,
          actorFrom(response),
        ),
      });
    },
  );

  app.delete(
    "/api/admin/mcp/services/:serviceId/versions/:versionId/tools/:toolId",
    async (request, response) => {
      await assertRouteVersion(request, actorFrom(response));
      const body = ExpectedRevisionSchema.parse(request.body);
      await management.deleteTool(
        request.params.versionId as string,
        request.params.toolId as string,
        body.expectedRevision,
        actorFrom(response),
      );
      response.status(204).end();
    },
  );

  app.get(
    "/api/admin/mcp/services/:serviceId/versions/:versionId/prompts",
    async (request, response) => {
      const version = await assertRouteVersion(request, actorFrom(response));
      response.json({ prompts: version.prompts, revision: version.revision });
    },
  );

  app.post(
    "/api/admin/mcp/services/:serviceId/versions/:versionId/prompts",
    async (request, response) => {
      await assertRouteVersion(request, actorFrom(response));
      const body = AddPromptBodySchema.parse(request.body);
      const version = await management.addPrompt(
        request.params.versionId as string,
        body.prompt,
        body.expectedRevision,
        actorFrom(response),
      );
      response.status(201).json({ version });
    },
  );

  app.patch(
    "/api/admin/mcp/services/:serviceId/versions/:versionId/prompts/:promptId",
    async (request, response) => {
      await assertRouteVersion(request, actorFrom(response));
      const body = UpdatePromptBodySchema.parse(request.body);
      response.json({
        version: await management.updatePrompt(
          request.params.versionId as string,
          request.params.promptId as string,
          body.prompt,
          body.expectedRevision,
          actorFrom(response),
        ),
      });
    },
  );

  app.delete(
    "/api/admin/mcp/services/:serviceId/versions/:versionId/prompts/:promptId",
    async (request, response) => {
      await assertRouteVersion(request, actorFrom(response));
      const body = ExpectedRevisionSchema.parse(request.body);
      await management.deletePrompt(
        request.params.versionId as string,
        request.params.promptId as string,
        body.expectedRevision,
        actorFrom(response),
      );
      response.status(204).end();
    },
  );

  app.post(
    "/api/admin/mcp/services/:serviceId/versions/:versionId/prompts/:promptId/preview",
    async (request, response) => {
      await assertRouteVersion(request, actorFrom(response));
      const body = PreviewPromptBodySchema.parse(request.body);
      response.json({
        prompt: await management.previewPrompt(
          request.params.versionId as string,
          request.params.promptId as string,
          body.arguments,
          actorFrom(response),
        ),
      });
    },
  );

  app.post(
    "/api/admin/mcp/services/:serviceId/versions/:versionId/validate",
    async (request, response) => {
      await assertRouteVersion(request, actorFrom(response));
      const body = ExpectedRevisionSchema.parse(request.body);
      response.json({
        version: await management.validateVersion(
          request.params.versionId as string,
          body.expectedRevision,
          actorFrom(response),
        ),
      });
    },
  );

  app.post(
    "/api/admin/mcp/services/:serviceId/versions/:versionId/reset-to-draft",
    async (request, response) => {
      await assertRouteVersion(request, actorFrom(response));
      const body = ExpectedRevisionSchema.parse(request.body);
      response.json({
        version: await management.resetVersionToDraft(
          request.params.versionId as string,
          body.expectedRevision,
          actorFrom(response),
        ),
      });
    },
  );

  app.post(
    "/api/admin/mcp/services/:serviceId/versions/:versionId/fork-draft",
    async (request, response) => {
      response.json({
        version: await management.forkDraftVersion(
          request.params.serviceId as string,
          request.params.versionId as string,
          actorFrom(response),
        ),
      });
    },
  );

  app.post(
    "/api/admin/mcp/services/:serviceId/versions/:versionId/publish",
    async (request, response) => {
      await assertRouteVersion(request, actorFrom(response));
      const body = ExpectedRevisionSchema.parse(request.body);
      response.json(
        await management.publishVersion(
          request.params.versionId as string,
          body.expectedRevision,
          actorFrom(response),
        ),
      );
    },
  );

  app.post(
    "/api/admin/mcp/services/:serviceId/versions/:versionId/rollback",
    async (request, response) => {
      await assertRouteVersion(request, actorFrom(response));
      const body = ExpectedRevisionSchema.parse(request.body);
      response.json(
        await management.rollbackVersion(
          request.params.serviceId as string,
          request.params.versionId as string,
          body.expectedRevision,
          actorFrom(response),
        ),
      );
    },
  );

  if (options.artifactUploads) {
    const artifactUploads = options.artifactUploads;

    app.post(
      "/api/admin/mcp/services/:serviceId/versions/:versionId/upload-url",
      async (request, response) => {
        response.json(
          await artifactUploads.requestUpload(
            request.params.serviceId as string,
            request.params.versionId as string,
            request.body as { sha256: string; size: number },
            actorFrom(response),
          ),
        );
      },
    );

    app.post(
      "/api/admin/mcp/services/:serviceId/versions/:versionId/complete-upload",
      async (request, response) => {
        const completed = await artifactUploads.completeUpload(
          request.params.serviceId as string,
          request.params.versionId as string,
          request.body as {
            objectKey: string;
            sha256: string;
            size: number;
            expectedRevision: number;
          },
          actorFrom(response),
        );
        response.status(202).json(completed);
      },
    );
  }

  if (options.buildQueue) {
    const buildQueue = options.buildQueue;
    app.post(
      "/api/admin/mcp/services/:serviceId/versions/:versionId/build",
      async (request, response) => {
        await assertRouteVersion(request, actorFrom(response));
        const body = ExpectedRevisionSchema.parse(request.body);
        const queued = await management.queueBuild(
          request.params.versionId as string,
          body.expectedRevision,
          actorFrom(response),
        );
        const jobPayload = {
          buildJobId: queued.job.id,
          serviceId: queued.version.serviceId,
          versionId: queued.version.id,
          versionRevision: queued.version.revision,
          objectKey: queued.job.artifactObjectKey,
          artifactDigest: queued.job.artifactDigest,
          artifactSize: queued.job.artifactSize,
        };
        let dispatched = true;
        try {
          await buildQueue.enqueueBuild(jobPayload);
        } catch {
          dispatched = false;
        }
        response.status(202).json({ ...queued, dispatched });
      },
    );
  }

  if (options.clientAccess) {
    const clientAccess = options.clientAccess;

    app.get("/api/admin/mcp/clients", async (_request, response) => {
      response.json({ clients: await clientAccess.listClients(actorFrom(response)) });
    });

    app.post("/api/admin/mcp/clients", async (request, response) => {
      const client = await clientAccess.createClient(
        { name: (request.body as { name?: string }).name ?? "" },
        actorFrom(response),
      );
      response.status(201).json({ client });
    });

    app.get("/api/admin/mcp/clients/:clientId/keys", async (request, response) => {
      response.json({
        keys: await clientAccess.listApiKeys(
          request.params.clientId as string,
          actorFrom(response),
        ),
      });
    });

    app.post("/api/admin/mcp/clients/:clientId/keys", async (request, response) => {
      const issued = await clientAccess.createApiKey(
        request.params.clientId as string,
        { expiresAt: (request.body as { expiresAt?: string | null }).expiresAt },
        actorFrom(response),
      );
      response.status(201).json(issued);
    });

    app.delete("/api/admin/mcp/clients/:clientId/keys/:keyId", async (request, response) => {
      await clientAccess.revokeApiKey(
        request.params.clientId as string,
        request.params.keyId as string,
        actorFrom(response),
      );
      response.status(204).end();
    });

    app.get("/api/admin/mcp/clients/:clientId/grants", async (request, response) => {
      response.json({
        grants: await clientAccess.listGrants(
          request.params.clientId as string,
          actorFrom(response),
        ),
      });
    });

    app.put("/api/admin/mcp/clients/:clientId/grants/:serviceId", async (request, response) => {
      const body = request.body as {
        scopes?: McpScope[];
        promptNames?: string[] | null;
        toolNames?: string[] | null;
      };
      response.json({
        grant: await clientAccess.upsertGrant(
          request.params.clientId as string,
          request.params.serviceId as string,
          {
            scopes: body.scopes ?? [],
            promptNames: body.promptNames ?? null,
            toolNames: body.toolNames ?? null,
          },
          actorFrom(response),
        ),
      });
    });

    app.delete("/api/admin/mcp/clients/:clientId/grants/:serviceId", async (request, response) => {
      await clientAccess.deleteGrant(
        request.params.clientId as string,
        request.params.serviceId as string,
        actorFrom(response),
      );
      response.status(204).end();
    });
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      response.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: error.issues,
        },
      });
      return;
    }
    if (error instanceof ManagementError) {
      response.status(statusForError(error)).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
      return;
    }
    if (error instanceof ArtifactUploadError) {
      response.status(error.code === "OBJECT_MISSING" ? 404 : 409).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal error" } });
  });

  return app;
}
