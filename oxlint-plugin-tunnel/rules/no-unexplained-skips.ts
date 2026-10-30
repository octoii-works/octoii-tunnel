import { defineRule } from "@oxlint/plugins";
import { fieldOf, identifierName, isSyntaxNode, memberNames } from "../shared/syntax.ts";

/** The test functions, whose `skip` and `todo` leave a test out; `skipIf` states its reason as its condition. */
const TEST_FUNCTIONS = new Set(["it", "test", "describe"]);
const SKIPPING = new Set(["skip", "todo"]);

/**
 * A test left out (`skip`, `todo`) or given a timeout of its own says why, in a comment right before it: a
 * reason lets the next reader judge whether it still holds.
 */
export default defineRule({
	meta: { type: "problem", docs: { description: "Require a comment on skipped tests and per-test timeouts." } },
	create(context) {
		return {
			CallExpression(node) {
				const names = memberNames(node.callee);
				const skips = names !== undefined && TEST_FUNCTIONS.has(names[0]) && SKIPPING.has(names[1]);
				const timeout = TEST_FUNCTIONS.has(identifierName(node.callee) ?? "") && hasTimeout(node.arguments[2]);
				if (!skips && !timeout) return;
				let statement = node.parent;
				while (statement.type !== "ExpressionStatement" && statement.type !== "Program") statement = statement.parent;
				if (context.sourceCode.getCommentsBefore(statement).length > 0) return;
				context.report({ node, message: "Say why in a comment right before it: a skipped test, or one with a timeout of its own." });
			},
		};
	},
});

function hasTimeout(argument: unknown): boolean {
	if (!isSyntaxNode(argument)) return false;
	if (argument.type === "Literal") return typeof fieldOf(argument, "value") === "number";
	if (argument.type !== "ObjectExpression") return false;
	const properties = fieldOf(argument, "properties");
	return Array.isArray(properties) && properties.some((property) => isSyntaxNode(property) && identifierName(fieldOf(property, "key")) === "timeout");
}
