/**
 * How an operation talks to the outside world. The CLI streams compose output
 * to the terminal; the MCP server captures it (stdout is its JSON-RPC
 * channel) and keeps the event loop free while compose runs.
 */
export interface CoreIo {
  /** Inherit stdio for compose (CLI) instead of capturing output (MCP). */
  live: boolean;
  /** Directory wtc runs from: locates the repo and resolves `.` selectors. */
  cwd?: string;
  /** Cancels running compose commands (an MCP client's cancellation). */
  signal?: AbortSignal;
  /** Receives captured compose output lines (MCP progress), when not `live`. */
  onOutput?: (line: string) => void;
}
