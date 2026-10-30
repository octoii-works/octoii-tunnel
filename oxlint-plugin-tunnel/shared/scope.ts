/*
 * Adapted from MIT-licensed code, MIT License, Copyright (c) 2026 Dillon Mulroy; see ../THIRD_PARTY_NOTICES.
 * Our changes: none beyond its place beside the rules that use it.
 */
import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

/** Resolve an identifier to its binding by walking lexical scopes upward. */
export function resolveVariable(sourceCode: SourceCode, identifier: ESTree.IdentifierReference): Variable | null {
	let scope: Scope | null = sourceCode.getScope(identifier);
	while (scope !== null) {
		const variable = scope.set.get(identifier.name);
		if (variable !== undefined) return variable;
		scope = scope.upper;
	}
	return null;
}
