export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: Record<string, string | undefined>;
  /** Colors are used only for TTY output unless NO_COLOR is set. */
  color?: boolean;
  /** Abort signal for Ctrl+C. */
  signal?: AbortSignal;
}

export const EXIT = {
  OK: 0,
  /** Tests failed or requests errored. */
  FAILED: 1,
  /** Invalid usage, configuration or workspace problems. */
  USAGE: 2,
  /** Run was cancelled (SIGINT). */
  CANCELLED: 130,
} as const;

export interface Painter {
  green(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  dim(s: string): string;
  bold(s: string): string;
}

export function painter(enabled: boolean): Painter {
  const wrap = (open: number, close: number) => (s: string) => (enabled ? `\u001b[${open}m${s}\u001b[${close}m` : s);
  return { green: wrap(32, 39), red: wrap(31, 39), yellow: wrap(33, 39), cyan: wrap(36, 39), dim: wrap(2, 22), bold: wrap(1, 22) };
}
