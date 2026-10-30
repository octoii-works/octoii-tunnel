/** A node of the syntax tree as the test rules read it: its type and, by name, what it holds. */
export type SyntaxNode = { readonly type: string };

/** Whether a value is a node of the syntax tree. */
export function isSyntaxNode(value: unknown): value is SyntaxNode {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string";
}

/** A field of a node, read without trusting its shape. */
export function fieldOf(node: SyntaxNode, name: string): unknown {
	return Reflect.get(node, name);
}

/** The name an identifier node holds, or undefined for any other node. */
export function identifierName(node: unknown): string | undefined {
	if (!isSyntaxNode(node) || node.type !== "Identifier") return undefined;
	const name = fieldOf(node, "name");
	return typeof name === "string" ? name : undefined;
}

/** `object.property` as names, for a member expression of two identifiers; undefined for any other node. */
export function memberNames(node: unknown): readonly [string, string] | undefined {
	if (!isSyntaxNode(node) || node.type !== "MemberExpression") return undefined;
	const object = identifierName(fieldOf(node, "object"));
	const property = identifierName(fieldOf(node, "property"));
	return object === undefined || property === undefined ? undefined : [object, property];
}

/** Every node inside `node`, itself included, depth first. */
export function* nodesWithin(node: SyntaxNode): Generator<SyntaxNode> {
	yield node;
	for (const [key, value] of Object.entries(node)) {
		if (key === "parent") continue;
		const children = Array.isArray(value) ? value : [value];
		for (const child of children) if (isSyntaxNode(child)) yield* nodesWithin(child);
	}
}
