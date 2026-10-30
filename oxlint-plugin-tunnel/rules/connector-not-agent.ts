import { defineRule, type Ranged } from "@oxlint/plugins";
import { identifierName } from "../shared/syntax.ts";

/** The words of a name, split at its camel case, snake case and digits. */
function wordsOf(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[\s_$\d]+/)
		.filter((word) => word !== "")
		.map((word) => word.toLowerCase());
}

/** Whether a name misnames the connector, calling something an agent as the HTTP header's `userAgent` does not. */
function misnamesConnector(name: string): boolean {
	const words = wordsOf(name);
	return words.some((word, index) => word === "agent" && words[index - 1] !== "user");
}

/** The device-side process is the connector: no name the code declares calls it an agent. */
export default defineRule({
	meta: { type: "suggestion", docs: { description: "Disallow calling the device-side process an agent." } },
	create(context) {
		/** Reports a declaration whose name calls something an agent. */
		const check = (node: Ranged, named: unknown): void => {
			const name = identifierName(named);
			if (name !== undefined && misnamesConnector(name))
				context.report({ node, message: `The device-side process is the connector, not an agent: rename ${name}.` });
		};
		// Each node that declares a name, with where its name is.
		return {
			VariableDeclarator: (node) => check(node, node.id),
			FunctionDeclaration: (node) => check(node, node.id),
			ClassDeclaration: (node) => check(node, node.id),
			TSTypeAliasDeclaration: (node) => check(node, node.id),
			TSInterfaceDeclaration: (node) => check(node, node.id),
			MethodDefinition: (node) => check(node, node.key),
			PropertyDefinition: (node) => check(node, node.key),
			TSPropertySignature: (node) => check(node, node.key),
		};
	},
});
