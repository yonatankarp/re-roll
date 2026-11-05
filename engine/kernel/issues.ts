import type { z } from "zod";

export interface Issue {
  readonly plugin: string;
  readonly file: string | null;
  readonly message: string;
}

export function zodIssues(
  plugin: string,
  file: string,
  error: z.ZodError,
  prefix = "",
): Issue[] {
  return error.issues.map((problem) => {
    const path = problem.path.map(String).join(".");
    const location = [prefix, path].filter(Boolean).join(".");
    return {
      plugin,
      file,
      message: location ? `${location}: ${problem.message}` : problem.message,
    };
  });
}

export function formatIssue(issue: Issue): string {
  return `[${issue.plugin}] ${issue.file ? `${issue.file}: ` : ""}${issue.message}`;
}
