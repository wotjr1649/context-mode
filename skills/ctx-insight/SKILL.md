---
name: ctx-insight
description: |
  Open the upstream-hosted Insight dashboard in your default browser.
  Insight is a separate analytics product run by upstream at context-mode.com —
  it is not a ctxscribe feature. Per-engineer productive rate, retry waste,
  blocker detection, role-narrowed views.
  Trigger: /ctxscribe:ctx-insight
user-invocable: true
---

# ctx-insight — open the upstream-hosted Insight dashboard

Open the Insight dashboard in the user's default browser.

**Insight is a separate product, not a ctxscribe feature.** It is operated and
hosted by the upstream project at `context-mode.com`. ctxscribe only launches the
URL — sign-in, pricing, and everything shown there belong to upstream. Say so
when reporting to the user, so nobody mistakes Insight for a ctxscribe-owned
dashboard.

## Instructions

1. Call the `ctx_insight` MCP tool (no parameters). It opens
   <https://context-mode.com/insight> in the default browser and returns a
   confirmation line.
2. Display the tool's output to the user.
3. Tell the user:
   - "Insight opened at https://context-mode.com/insight — upstream's hosted
     dashboard, a separate product from ctxscribe."
   - The landing page at context-mode.com/insight is the single source of truth for sign-in and pricing details.
   - If the browser did not open automatically, share the URL so they can open it manually.
