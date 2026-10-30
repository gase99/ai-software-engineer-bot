import type { AiToolSpec } from '../ai/types.js';
import { createDefaultTools } from './tools.js';
import { toToolSpec, type AgentTool, type AgentContext } from './types.js';

/**
 * The agent's tool box.
 *
 * The model only ever sees `specs()`; execution goes through `get()` so an
 * unknown tool name coming back from a provider can never touch the system.
 */
export class ToolRegistry {
  private readonly tools: Map<string, AgentTool>;

  constructor(tools: AgentTool[] = createDefaultTools()) {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  specs(): AiToolSpec[] {
    return [...this.tools.values()].map(toToolSpec);
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  /** Grouped view used by the `/help`-style capability summary. */
  async availability(ctx: AgentContext): Promise<Array<{ tool: AgentTool; available: boolean; reason?: string }>> {
    const rows: Array<{ tool: AgentTool; available: boolean; reason?: string }> = [];
    for (const tool of this.tools.values()) {
      const availability = await tool.availability({ ...ctx, tools: this.list() });
      rows.push({ tool, available: availability.available, ...(availability.reason ? { reason: availability.reason } : {}) });
    }
    return rows;
  }
}
