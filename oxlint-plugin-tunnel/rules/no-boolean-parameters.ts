import { defineRule } from "@oxlint/plugins";

/** What the rule reads of a function's parameter. */
type Parameter = {
	readonly type: string;
	readonly range: [number, number];
	readonly optional?: boolean;
	readonly right?: { readonly type: string; readonly value?: unknown };
	readonly typeAnnotation?: { readonly typeAnnotation: { readonly type: string } } | null;
};

/**
 * No exported function takes a boolean flag: a positional parameter that defaults to `true` or `false`, or an optional
 * `boolean`. A caller leaves such a flag out to get one behaviour and passes it to get another, which two functions, or
 * an options object whose fields name the cases, say at the call. A required `boolean` is often a value, such as
 * whether a connection is up, and stays allowed.
 */
export default defineRule({
	meta: { type: "suggestion", docs: { description: "Disallow boolean flag parameters of exported functions." } },
	create(context) {
		const check = (params: readonly Parameter[], name: string): void => {
			for (const param of params) {
				if (!isFlag(param)) continue;
				context.report({ node: param, message: `${name} takes a boolean flag: make it two functions, or an options object that names the cases.` });
			}
		};
		return {
			ExportNamedDeclaration(node) {
				const declaration = node.declaration;
				if (declaration?.type === "FunctionDeclaration") check(declaration.params, declaration.id?.name ?? "The function");
			},
			ExportDefaultDeclaration(node) {
				const declaration = node.declaration;
				if (declaration.type === "FunctionDeclaration") check(declaration.params, declaration.id?.name ?? "The function");
			},
		};
	},
});

function isFlag(param: Parameter): boolean {
	if (param.type === "AssignmentPattern") return param.right?.type === "Literal" && typeof param.right.value === "boolean";
	return param.type === "Identifier" && param.optional === true && param.typeAnnotation?.typeAnnotation.type === "TSBooleanKeyword";
}
