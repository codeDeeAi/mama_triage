/**
 * The surface the triage and safety services depend on.
 *
 * Extracted so a second provider can stand in for the first when it is unavailable. The
 * services are written against this interface rather than a concrete client, which is
 * what makes a fallback possible without touching any of the safety logic.
 *
 * Whatever answers, the result passes through exactly the same checks: schema validation,
 * citation validation against the chunks actually retrieved, the deterministic red-flag
 * scan, and the urgency ratchet. A weaker model can therefore produce a worse assessment
 * but not a less safe one — it cannot lower an urgency, cite a document it was not shown,
 * or bypass a red flag.
 */

import type { ToolCallRequest, ToolCallResult } from './anthropic';

export interface ToolCallClient {
  callTool(req: ToolCallRequest): Promise<ToolCallResult>;
}
