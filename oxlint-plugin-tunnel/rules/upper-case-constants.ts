import { defineRule } from "@oxlint/plugins";
import { fieldOf, identifierName, isSyntaxNode } from "../shared/syntax.ts";

/** What a constant is written as: literals, and arithmetic and templates of nothing but literals. */
function isConstantExpression(node: unknown): boolean {
	if (!isSyntaxNode(node)) return false;
	switch (node.type) {
		case "Literal":
			return fieldOf(node, "value") !== null && fieldOf(node, "regex") === undefined;
		case "UnaryExpression":
			return isConstantExpression(fieldOf(node, "argument"));
		case "BinaryExpression":
			return isConstantExpression(fieldOf(node, "left")) && isConstantExpression(fieldOf(node, "right"));
		case "TemplateLiteral": {
			const expressions = fieldOf(node, "expressions");
			return Array.isArray(expressions) && expressions.length === 0;
		}
		default:
			return false;
	}
}

/** A module's constants, a number, a string or a sum of them that never changes, are named in UPPER_CASE. */
export default defineRule({
	meta: { type: "suggestion", docs: { description: "Require UPPER_CASE names for a module's literal constants." } },
	create(context) {
		return {
			Program(program) {
				for (const statement of program.body) {
					// A constant at the module's top, exported or not.
					const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
					if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
					for (const declarator of declaration.declarations) {
						const name = identifierName(declarator.id);
						if (name === undefined || /^[A-Z][A-Z0-9_]*$/.test(name) || !isConstantExpression(declarator.init)) continue;
						context.report({ node: declarator, message: `A module's constant is named in UPPER_CASE: rename ${name}.` });
					}
				}
			},
		};
	},
});
