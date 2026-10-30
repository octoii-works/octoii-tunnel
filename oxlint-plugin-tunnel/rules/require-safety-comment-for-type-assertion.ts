/*
 * Adapted from MIT-licensed code, MIT License, Copyright (c) 2026 Dillon Mulroy; see THIRD_PARTY_NOTICES.
 * Our changes: the options are read as the type `meta.schema` describes, a doc comment on the rule, and a default export for the plugin's index.
 */
import { defineRule } from "@oxlint/plugins";

import type { ESTree, Options, SourceCode } from "@oxlint/plugins";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

const DEFAULT_SAFETY_MARKERS = ["SAFETY"] as const;

const commentOwnerKinds = new Set(["ExpressionStatement", "PropertyDefinition", "ReturnStatement", "ThrowStatement", "VariableDeclaration"]);

function isConstAssertion(node: TypeAssertion): boolean {
	return node.typeAnnotation.type === "TSTypeReference" && node.typeAnnotation.typeName.type === "Identifier" && node.typeAnnotation.typeName.name === "const";
}

/** The rule's option as `meta.schema` describes it. */
type SafetyOption = { readonly markers?: readonly string[] };

function configuredSafetyMarkers(options: Readonly<Options> | undefined): readonly string[] {
	// SAFETY: oxlint checks the options against `meta.schema` and merges `defaultOptions` into them before the rule runs.
	const [option] = (options ?? []) as readonly (SafetyOption | undefined)[];
	const markers = (option?.markers ?? []).map((marker) => marker.trim()).filter((marker) => marker.length > 0);
	return markers.length > 0 ? markers : DEFAULT_SAFETY_MARKERS;
}

function markerPattern(markers: readonly string[]): RegExp {
	const alternation = markers.map((marker) => marker.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)).join("|");
	return new RegExp(String.raw`(?:^|[^\p{L}\p{N}_])(?:${alternation})\s*:\s*\S`, "u");
}

function hasSafetyJustificationBefore(sourceCode: SourceCode, owner: ESTree.Node, assertion: TypeAssertion, pattern: RegExp): boolean {
	return sourceCode.getCommentsBefore(owner).some((comment) => comment.end <= assertion.start && pattern.test(comment.value));
}

function hasSafetyComment(sourceCode: SourceCode, node: TypeAssertion, pattern: RegExp): boolean {
	let current: ESTree.Node = node;
	while (true) {
		if (hasSafetyJustificationBefore(sourceCode, current, node, pattern)) return true;
		if (commentOwnerKinds.has(current.type)) {
			const exportDeclaration = current.parent;
			return (
				exportDeclaration.type === "ExportNamedDeclaration" &&
				exportDeclaration.declaration === current &&
				hasSafetyJustificationBefore(sourceCode, exportDeclaration, node, pattern)
			);
		}
		if (current.parent.type === "Program") return false;
		current = current.parent;
	}
}

/**
 * Every type assertion but `as const` says, in a `SAFETY:` comment before it or its statement, the invariant that makes
 * it true: an assertion is a claim the type checker cannot verify, so the reader needs the reason.
 */
export default defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Require a nearby SAFETY comment for every TypeScript type assertion except const assertions.",
		},
		messages: {
			missingSafetyComment:
				"This type assertion has no `{{marker}}:` justification. State the checked invariant immediately before the assertion or its containing statement.",
		},
		schema: [
			{
				type: "object",
				properties: {
					markers: {
						type: "array",
						items: { type: "string", minLength: 1 },
						minItems: 1,
						uniqueItems: true,
					},
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [{ markers: ["SAFETY"] }],
	},
	createOnce(context) {
		const patterns = new Map<string, RegExp>();

		const checkAssertion = (node: TypeAssertion) => {
			if (isConstAssertion(node)) return;
			const markers = configuredSafetyMarkers(context.options);
			const patternKey = markers.join("\u0000");
			const pattern = patterns.get(patternKey) ?? markerPattern(markers);
			patterns.set(patternKey, pattern);
			if (hasSafetyComment(context.sourceCode, node, pattern)) return;
			context.report({
				node,
				messageId: "missingSafetyComment",
				data: { marker: markers[0] ?? DEFAULT_SAFETY_MARKERS[0] },
			});
		};

		return {
			TSAsExpression: checkAssertion,
			TSTypeAssertion: checkAssertion,
		};
	},
});
