#!/usr/bin/env node
/**
 * UserPromptSubmit hook for ctxscribe session continuity.
 *
 * Captures every user prompt so the LLM can continue from the exact
 * point where the user left off after compact or session restart.
 *
 * Must be fast (<10ms). Just a single SQLite write.
 *
 * Crash-resilience: wrapped via runHook (#414) — module loads happen
 * dynamically so missing deps log + exit 0 instead of MODULE_NOT_FOUND.
 */

import { runHook } from "./run-hook.mjs";

await runHook(async () => {
  const {
    readStdin,
    parseStdin,
    getSessionId,
    getSessionDBPath,
    getInputProjectDir,
  } = await import("./session-helpers.mjs");
  const { createSessionLoaders, attributeAndInsertEvents } = await import("./session-loaders.mjs");
  const { dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
  const { loadSessionDB, loadExtract, loadProjectAttribution } = createSessionLoaders(HOOK_DIR);

  // v1.0.3: raw prompt capture is OPT-IN and OFF by default (see block below).
  const CAPTURE_PROMPTS = process.env.CONTEXT_MODE_PROMPT_CAPTURE === "1";

  try {
    const { redactSecretText } = await import("./platform-bridge.mjs");
    const raw = await readStdin();
    const input = parseStdin(raw);
    const projectDir = getInputProjectDir(input);

    // v1.0.3: strip credential/token values at the input boundary so NO
    // prompt-derived event (structured intents/decisions AND the opt-in raw row)
    // can carry a verbatim API key or token into SQLite. Only credential
    // patterns are masked (not emails/ids), so normal continuity prose is
    // preserved; PII minimization happens on the remote wire, not local storage.
    const prompt = redactSecretText(input.prompt ?? input.message ?? "");
    const trimmed = (prompt || "").trim();

    // Skip system-generated messages — only capture genuine user prompts
    const isSystemMessage = trimmed.startsWith("<task-notification>")
      || trimmed.startsWith("<system-reminder>")
      || trimmed.startsWith("<context_guidance>")
      || trimmed.startsWith("<tool-result>");

    if (trimmed.length > 0 && !isSystemMessage) {
      const { SessionDB } = await loadSessionDB();
      const { extractUserEvents, extractUserPromptFeatures } = await loadExtract();
      const { resolveProjectAttributions } = await loadProjectAttribution();
      const dbPath = getSessionDBPath();
      const db = new SessionDB({ dbPath });
      const sessionId = getSessionId(input);

      db.ensureSession(sessionId, projectDir);

      // 1. Raw prompt capture is OPT-IN and OFF by default (v1.0.3).
      // The verbatim prompt (and its word-token features) can carry API keys,
      // tokens, passwords or PII. The project's own standard is "never ship
      // secrets to SQLite" (src/session/extract.ts redactSecrets, applied to
      // tool_input); storing the raw prompt unconditionally violated it. By
      // default we skip the raw user_prompt row entirely — continuity still
      // works from the structured decision/role/intent events extracted below.
      // Opt-in (CONTEXT_MODE_PROMPT_CAPTURE=1) stores the prompt, but only
      // after a best-effort secret scrub. See configs/claude-code/CLAUDE.md.
      let promptAttributions = [];
      if (CAPTURE_PROMPTS) {
        const promptFeatures = typeof extractUserPromptFeatures === "function"
          ? extractUserPromptFeatures(trimmed)
          : {};
        const promptEvent = {
          type: "user_prompt",
          category: "user-prompt",
          data: prompt,
          priority: 1,
          ...promptFeatures,
        };
        promptAttributions = attributeAndInsertEvents(
          db, sessionId, [promptEvent], input, projectDir, "UserPromptSubmit", resolveProjectAttributions,
        );
      }

      // 2. Extract decision/role/intent/data from user message
      const userEvents = extractUserEvents(trimmed);
      // Feed lastKnownProjectDir from the first attribution into the second batch
      const savedLastKnown = promptAttributions[0]?.projectDir || null;
      const sessionStats = db.getSessionStats(sessionId);
      const lastKnownProjectDir = typeof db.getLatestAttributedProjectDir === "function"
        ? db.getLatestAttributedProjectDir(sessionId)
        : null;
      const userAttributions = resolveProjectAttributions(userEvents, {
        sessionOriginDir: sessionStats?.project_dir || projectDir,
        inputProjectDir: projectDir,
        workspaceRoots: Array.isArray(input.workspace_roots) ? input.workspace_roots : [],
        lastKnownProjectDir: savedLastKnown || lastKnownProjectDir,
      });
      // v1.0.160: route through wire so prompt-derived events (decision /
       // role / intent / data extractions) reach the platform. Previously
       // they only landed in local SessionDB → dashboard's prompt-flow
       // insights stayed at 0.
      if (userEvents.length > 0) {
        attributeAndInsertEvents(
          db,
          sessionId,
          userEvents,
          input,
          projectDir,
          "UserPromptSubmit",
          resolveProjectAttributions,
        );
      }

      db.close();
    }
  } catch {
    // UserPromptSubmit must never block the session — silent fallback
  }
});
