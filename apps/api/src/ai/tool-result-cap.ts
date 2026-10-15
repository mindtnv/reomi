import { env } from '../env.ts';

export function capStoredToolResult(toolName: string, text: string): string {
  const limit = env.ai.TOOL_RESULT_MAX_CHARS;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated]`;
}
