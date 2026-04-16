import { TOOL_NAMES } from '../types.js';
import * as sendToThread from './send-to-thread.js';
import * as listBots from './list-bots.js';

// NOTE: get_thread_messages was migrated to the `botmux thread messages` CLI
// subcommand + botmux-thread-messages skill (April 2026).  MCP now only
// carries tools that genuinely need session-stdio context coupling.
export const tools = {
  [TOOL_NAMES.SEND_TO_THREAD]: sendToThread,
  [TOOL_NAMES.LIST_BOTS]: listBots,
} as const;
