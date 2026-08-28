import { FrameworkError } from "absorb-anything-core";

export const SEMANTIC_TOPICS = [
  "workspace",
  "project",
  "task",
  "roadmap",
  "spec",
  "system",
] as const;
export type SemanticTopic = (typeof SEMANTIC_TOPICS)[number];

export interface ObjectSemantics {
  readonly topic: SemanticTopic;
  readonly label: string;
  readonly purpose: string;
  readonly antiRule: string;
  readonly whyItExists: readonly string[];
  readonly whenNotToUse: readonly string[];
  readonly commonMisuses: readonly string[];
  readonly commands: readonly string[];
}

export const OBJECT_SEMANTICS: readonly ObjectSemantics[] = [
  {
    topic: "workspace",
    label: "Workspace",
    purpose: "the shared envelope and directory map for project work",
    antiRule: "initialize one envelope and let every owned object use its active context",
    whyItExists: [
      "One envelope keeps project identity, records, coordination, and events together.",
    ],
    whenNotToUse: ["Do not initialize a second workspace inside an existing one."],
    commonMisuses: ["Creating parallel envelope directories instead of using the active one."],
    commands: ["ownwork init [target]", "ownwork status", "ownwork check"],
  },
  {
    topic: "project",
    label: "Project",
    purpose: "the identity authority shared by work in this workspace",
    antiRule: "project acceptance does not move into a Task or Roadmap item",
    whyItExists: ["Every owned object needs one stable project identity."],
    whenNotToUse: ["Use a Task for one bounded outcome and a Spec for a durable constraint."],
    commonMisuses: ["Treating Task completion as Project acceptance."],
    commands: ["ownwork status", "ownwork check"],
  },
  {
    topic: "task",
    label: "Task",
    purpose: "one bounded outcome with a durable identity across sessions and attempts",
    antiRule: "a new attempt at the same outcome is not a new Task",
    whyItExists: [
      "A stable id lets another session resume the same outcome without splitting its history.",
    ],
    whenNotToUse: ["Use a plain directory for uniform items that need no durable state."],
    commonMisuses: [
      "Creating another Task to retry the same outcome.",
      "Editing task.json by hand.",
    ],
    commands: [
      "ownwork task create --title <text>",
      "ownwork task list",
      "ownwork task finish <id>",
    ],
  },
  {
    topic: "roadmap",
    label: "Roadmap",
    purpose: "an intended Project outcome with commitment and horizon",
    antiRule: "a Roadmap item is an outcome, not the work plan",
    whyItExists: ["Direction stays distinct from the Tasks used to realize it."],
    whenNotToUse: ["Use a Task for bounded execution and a Spec for a normative constraint."],
    commonMisuses: ["Expecting linked Task lifecycle to propagate into the Roadmap item."],
    commands: [
      "ownwork roadmap create --title <text>",
      "ownwork roadmap link-task <id> --task <task-id>",
    ],
  },
  {
    topic: "spec",
    label: "Spec",
    purpose: "a current normative constraint that remains addressable after its source work",
    antiRule: "activation validates structure; it is not Project acceptance",
    whyItExists: [
      "A durable constraint needs an address independent from the Task that produced it.",
    ],
    whenNotToUse: ["Keep unresolved work in its Task until the constraint is ready to state."],
    commonMisuses: ["Expecting promotion to finish or archive its source Task."],
    commands: [
      "ownwork spec create --title <text> --scope project --strength required",
      "ownwork spec promote --from-task <id> --task-file <file> --body <file>",
    ],
  },
  {
    topic: "system",
    label: "System registry",
    purpose: "the addressable systems being built and the one that is primary",
    antiRule: "exactly one live System is primary",
    whyItExists: [
      "Specs and other work can refer to a stable System selector instead of guessing a path.",
    ],
    whenNotToUse: ["Do not register external study material as a System."],
    commonMisuses: ["Re-registering to change metadata instead of using system update."],
    commands: [
      "ownwork system register <path>",
      "ownwork system update <selector>",
      "ownwork system list",
    ],
  },
];

export const SEMANTIC_DIGEST_TOPICS: readonly SemanticTopic[] = [
  "project",
  "task",
  "roadmap",
  "spec",
  "system",
];
export interface SemanticDigestEntry {
  readonly topic: SemanticTopic;
  readonly label: string;
  readonly purpose: string;
  readonly antiRule: string;
}
export const SEMANTIC_DETAIL_COMMAND = "ownwork explain <topic>";

export function requireObjectSemantics(topic: string): ObjectSemantics {
  const normalized = topic.trim().toLowerCase();
  const found = OBJECT_SEMANTICS.find((entry) => entry.topic === normalized);
  if (!found)
    throw new FrameworkError(
      `unknown topic '${topic}'; explain covers: ${SEMANTIC_TOPICS.join(", ")}`,
      { code: "NOT_FOUND" },
    );
  return found;
}
export function semanticDigest(): readonly SemanticDigestEntry[] {
  return SEMANTIC_DIGEST_TOPICS.map((topic) => {
    const entry = requireObjectSemantics(topic);
    return { topic, label: entry.label, purpose: entry.purpose, antiRule: entry.antiRule };
  });
}
export function semanticDigestSentence(entry: SemanticDigestEntry): string {
  return `${entry.label} is ${entry.purpose}. Most-broken rule: ${entry.antiRule}.`;
}

export const SEMANTIC_HINTS = {
  "task create":
    "One durable outcome is one Task; a new attempt at the same outcome is not a new Task.",
  "task finish":
    "finish marks the outcome done; it does not archive the Task, accept it for the Project, or realize a Roadmap item.",
  "spec promote":
    "A Spec states the current constraint; promotion does not finish, archive, or back-reference its source Task.",
} as const;
export type SemanticHintKey = keyof typeof SEMANTIC_HINTS;
export function semanticHints(key: SemanticHintKey): readonly string[] {
  return [SEMANTIC_HINTS[key]];
}

export const SEMANTIC_MODELS = {
  taskTerminal:
    "Terminal Tasks stay terminal: create a successor Task and record `continues` or `supersedes`.",
  taskArchived: "An archived Task is a record: create a successor Task when the outcome continues.",
  taskNotTerminal:
    "Archive follows a terminal status: run `ownwork task finish`, or set cancelled or superseded first.",
  taskEnvelope:
    "task.json is the machine envelope: edit `prd.md` directly and let `ownwork task` write envelope fields.",
  taskContextBinding: "One context resolves to one Task: pass `--rebind` to move it.",
  taskDuplicateStorage:
    "One Task id lives in one directory: prefixes are navigation, so remove the unwanted copy.",
  systemAlreadyRegistered:
    "A registered System keeps its record: correct it with `ownwork system update <selector>`.",
} as const;
export type SemanticModelKey = keyof typeof SEMANTIC_MODELS;
export function withSemanticModel(message: string, key: SemanticModelKey): string {
  return `${message}. ${SEMANTIC_MODELS[key]}`;
}
