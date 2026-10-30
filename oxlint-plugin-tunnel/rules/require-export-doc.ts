import { defineRule } from "@oxlint/plugins";

/**
 * Every exported function, class, type, interface and constant says what it is or does in a doc comment (`/** … *\/`)
 * right before its export; re-exports are documented where they are declared.
 */
export default defineRule({
	meta: { type: "suggestion", docs: { description: "Require a doc comment on every exported declaration." } },
	create(context) {
		const isDoc = (value: string): boolean => value.startsWith("*");
		return {
			ExportNamedDeclaration(node) {
				if (node.declaration === null) return;
				const before = context.sourceCode.getCommentsBefore(node);
				const last = before.at(-1);
				if (last === undefined || last.type !== "Block" || !isDoc(last.value))
					context.report({ node, message: "An exported declaration says what it is or does in a doc comment before it." });
			},
			ExportDefaultDeclaration(node) {
				const last = context.sourceCode.getCommentsBefore(node).at(-1);
				if (last === undefined || last.type !== "Block" || !isDoc(last.value))
					context.report({ node, message: "An exported declaration says what it is or does in a doc comment before it." });
			},
		};
	},
});
