import type { Express } from 'express';
import type { RouteDeps } from '../server-context.js';
import { isKnownReasoningEffort, resolveModelForServiceTier } from '../runtimes/models.js';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';

// Allowlist for the `/feedback` route. Mirrors the
// ChatMessageFeedbackReasonCode union in packages/contracts/src/api/chat.ts.
// Kept inline (not imported as a runtime value, since the contract type is
// type-only) so a stale client can't poison Langfuse with unknown categories.
const FEEDBACK_REASON_ALLOWLIST: ReadonlySet<string> = new Set([
  'matched_request',
  'strong_visual',
  'useful_structure',
  'easy_to_continue',
  'followed_design_system',
  'missed_request',
  'weak_visual',
  'could_not_run',
  'too_slow',
  'incomplete_output',
  'hard_to_use',
  'missed_design_system',
  'other',
]);

export interface RegisterChatRoutesDeps extends RouteDeps<'db' | 'design' | 'http' | 'chat' | 'agents' | 'critique' | 'validation' | 'lifecycle' | 'paths' | 'telemetry' | 'appConfig'> {
  authorizeProjectRequest: AuthorizeProjectRequest;
}

export function registerChatRoutes(app: Express, ctx: RegisterChatRoutesDeps) {
  const { db, design } = ctx;
  const { sendApiError } = ctx.http;
  const { readAppConfig } = ctx.appConfig;
  const { testAgentConnection, getAgentDef, isKnownModel, isKnownServiceTier, sanitizeCustomModel } = ctx.agents;
  const {
    handleCritiqueArtifact,
    handleCritiqueInterrupt,
    critiqueArtifactsRoot,
    critiqueResponseCapBytes,
    critiqueRunRegistry,
  } = ctx.critique;
  // Run lifecycle routes live in `routes/runs.ts`; this file owns feedback,
  // the agent connection test, and critique handoff. The BYOK provider proxy
  // routes (`/api/proxy/*/stream`, `/api/provider/models`) are gone: on
  // Databricks every model call goes through Model Serving.

  // Receives the user's thumbs-up/down (+ reason codes) for an assistant
  // turn and forwards it to Langfuse as a `score-create`. Web persists the
  // feedback itself via PUT /messages/:id; this endpoint exists only as a
  // telemetry side channel — the daemon is the single network egress for
  // Langfuse and gates on `telemetry.metrics + telemetry.content` consent.
  //
  // The consent + sink decision is fast (awaits a small file read, no
  // network); we await it so the response status honestly reflects whether
  // the score was enqueued, skipped for consent, or skipped because no
  // Langfuse sink is configured. The actual Langfuse network call happens
  // as a detached promise inside the bridge.
  app.post('/api/runs/:id/feedback', async (req, res) => {
    const runId = req.params.id;
    const body = (req.body ?? {}) as Partial<{
      rating: 'positive' | 'negative';
      reasonCodes: string[];
      hasCustomReason: boolean;
      customReason: string;
    }> & Record<string, unknown>;
    if (!runId) {
      return sendApiError(res, 400, 'INVALID_RUN_ID', 'runId missing');
    }
    const callerOwnedContextFields = [
      'projectId',
      'conversationId',
      'assistantMessageId',
    ].filter((field) => Object.prototype.hasOwnProperty.call(body, field));
    if (callerOwnedContextFields.length > 0) {
      return sendApiError(
        res,
        400,
        'INVALID_FEEDBACK_CONTEXT',
        'feedback project, conversation, and message identity are derived from the run',
      );
    }
    if (body.rating !== 'positive' && body.rating !== 'negative') {
      return sendApiError(res, 400, 'INVALID_RATING', 'rating must be positive or negative');
    }
    const run = design.runs.get(runId);
    if (!run || typeof run.projectId !== 'string' || !run.projectId) {
      return sendApiError(res, 404, 'NOT_FOUND', 'run not found');
    }
    if (!await ctx.authorizeProjectRequest(
      req,
      res,
      run.projectId,
      { mode: 'write', capability: 'writeFiles' },
    )) return;
    // Drop anything outside the contract-side reason allowlist and
    // deduplicate; otherwise a malformed or replayed client payload could
    // create unknown Langfuse categories or duplicate score ids in the
    // same batch.
    const reasonCodes = Array.isArray(body.reasonCodes)
      ? Array.from(
          new Set(
            body.reasonCodes.filter(
              (c): c is string =>
                typeof c === 'string' && FEEDBACK_REASON_ALLOWLIST.has(c),
            ),
          ),
        )
      : [];
    const customReason = typeof body.customReason === 'string' ? body.customReason : '';
    const reportFeedback = ctx.telemetry?.reportFeedback;
    if (!reportFeedback) {
      res.status(202).json({ status: 'skipped_no_sink' });
      return;
    }
    // Build score metadata bag that lands in the Langfuse score body.
    // Mirrors the PostHog event so analysts can cross-reference. Every
    // identity field comes from the daemon-owned run object; request bodies
    // cannot retarget a score to another project/conversation/message.
    const scoreMetadata: Record<string, unknown> = {
      projectId: run.projectId,
      conversationId: run.conversationId ?? null,
      assistantMessageId: run.assistantMessageId ?? null,
      hasCustomReason: body.hasCustomReason === true,
      customReason,
    };
    const outcome = await reportFeedback({
      runId,
      rating: body.rating,
      reasonCodes,
      hasCustomReason: body.hasCustomReason === true,
      customReason,
      scoreMetadata,
    });
    res.status(202).json(outcome);
  });

  // ---- Connection tests (single-shot JSON; no SSE) ------------------------
  // Settings dialog uses these to verify a config works without sending a
  // real chat. Always return HTTP 200 with `ok: false` on upstream-caused
  // failures so the web layer can render a categorized inline status without
  // unwrapping nested error envelopes; real 4xx/5xx here mean a malformed
  // request or daemon bug.
  app.post('/api/test/connection', async (req, res) => {
    const controller = new AbortController();
    const abortIfRequestAborted = () => {
      if ((req.aborted || !req.complete) && !res.writableEnded) {
        controller.abort();
      }
    };
    const abortIfResponseClosed = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.on('close', abortIfRequestAborted);
    res.on('close', abortIfResponseClosed);
    const body = req.body || {};
    try {
      if (body.mode === 'agent') {
        if (typeof body.agentId !== 'string' || !body.agentId.trim()) {
          return sendApiError(res, 400, 'BAD_REQUEST', 'agentId is required');
        }
        try {
          const def = getAgentDef(body.agentId);
          const testStart = Date.now();
          const appConfig = await readAppConfig(ctx.paths.RUNTIME_DATA_DIR).catch(() => ({}));
          const configuredModel =
            def && typeof appConfig.agentModels?.[def.id]?.model === 'string'
              ? appConfig.agentModels[def.id].model
              : undefined;
          const requestedModel =
            typeof body.model === 'string' ? body.model : configuredModel;
          let safeModel =
            def && typeof requestedModel === 'string'
              ? isKnownModel(def, requestedModel)
                ? requestedModel
                : sanitizeCustomModel(requestedModel)
              : undefined;
          if (def && typeof body.model === 'string' && body.model.trim() && !safeModel) {
            return res.json({
              ok: false,
              kind: 'invalid_model_id',
              latencyMs: Date.now() - testStart,
              model: body.model.trim(),
              agentName: def.name,
              detail: 'Invalid custom model id. Use a model id that starts with a letter or number and contains no spaces.',
            });
          }
          const safeReasoning =
            def &&
            typeof body.reasoning === 'string' &&
            isKnownReasoningEffort(def, safeModel, body.reasoning)
              ? body.reasoning
              : undefined;
          safeModel = def
            ? resolveModelForServiceTier(
                def,
                safeModel,
                typeof body.serviceTier === 'string' ? body.serviceTier : null,
              ) ?? undefined
            : safeModel;
          const safeServiceTier =
            def &&
            typeof body.serviceTier === 'string' &&
            isKnownServiceTier(def, safeModel, body.serviceTier)
              ? body.serviceTier
              : undefined;
          const result = await testAgentConnection({
            agentId: body.agentId,
            model: safeModel ?? undefined,
            reasoning: safeReasoning,
            serviceTier: safeServiceTier,
            agentCliEnv:
              body.agentCliEnv && typeof body.agentCliEnv === 'object'
                ? body.agentCliEnv
                : undefined,
            signal: controller.signal,
          });
          return res.json(result);
        } catch (err: any) {
          console.warn(
            `[test:agent] uncaught: ${err instanceof Error ? err.message : String(err)}`,
          );
          return sendApiError(res, 500, 'INTERNAL', 'Agent test failed');
        }
      }

      return sendApiError(
        res,
        400,
        'BAD_REQUEST',
        // BYOK provider tests are gone with the external model paths; only
        // the (Databricks) agent can be tested.
        'mode must be agent',
      );
    } finally {
      req.off('close', abortIfRequestAborted);
      res.off('close', abortIfResponseClosed);
    }
  });

  // ---- Critique Theater endpoints (Phase 6) --------------------------------

  // POST /api/projects/:projectId/critique/:runId/interrupt
  // Cascades an AbortController to the in-flight orchestrator for the given run.
  const critiqueInterruptHandler =
    handleCritiqueInterrupt(db, critiqueRunRegistry);
  app.post(
    '/api/projects/:projectId/critique/:runId/interrupt',
    async (req, res) => {
      if (!await ctx.authorizeProjectRequest(
        req,
        res,
        req.params.projectId,
        { mode: 'write', capability: 'writeFiles' },
      )) return;
      critiqueInterruptHandler(req, res);
    },
  );

  // GET /api/projects/:projectId/critique/:runId/artifact
  // Streams the SHIP <ARTIFACT> body the orchestrator persisted, with
  // mime derived from the file extension on disk. Cross-project leak
  // guard mirrors the interrupt route. The web layer fetches this as
  // the logical artifact handle so it never sees daemon paths.
  //
  // Response cap is threaded from cfg.parserMaxBlockBytes so a row that
  // the orchestrator + writer accepted is always retrievable.
  const critiqueArtifactHandler = handleCritiqueArtifact(db, {
    artifactsRoot: critiqueArtifactsRoot,
    responseCapBytes: critiqueResponseCapBytes,
  });
  app.get(
    '/api/projects/:projectId/critique/:runId/artifact',
    async (req, res) => {
      if (!await ctx.authorizeProjectRequest(
        req,
        res,
        req.params.projectId,
        { mode: 'read', allowNavigationQuery: true },
      )) return;
      await critiqueArtifactHandler(req, res);
    },
  );
}
