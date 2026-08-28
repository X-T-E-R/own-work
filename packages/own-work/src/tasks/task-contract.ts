export const TASK_HANDOFF_HEADINGS = [
  "# Current State",
  "## Completed Outcomes",
  "## Working State",
  "## Verification Evidence",
  "## Next Action",
  "## Open Blockers and Decisions",
] as const;

export function renderTaskPrd(title: string, description?: string): string {
  const displayTitle = title.trim() || "Untitled Task";
  const goal = description?.trim() || title.trim();
  return `# ${displayTitle}\n\n## Goal\n\n${goal}\n\n## Acceptance Criteria\n\n- [ ] The intended outcome is complete and backed by recorded verification evidence.\n`;
}
