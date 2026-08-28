import { type SemanticHintKey, semanticHints } from "./semantics.js";

export function hintLines(key: SemanticHintKey): readonly string[] {
  return semanticHints(key).map((hint) => `Hint: ${hint}`);
}
export function withHintLines(text: string, key: SemanticHintKey): string {
  return [text, ...hintLines(key)].join("\n");
}
export function hintedResult<T extends object>(
  result: T,
  key: SemanticHintKey,
): T & { readonly hints: readonly string[] } {
  return { ...result, hints: semanticHints(key) };
}
