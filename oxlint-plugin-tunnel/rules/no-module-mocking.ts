/*
 * Adapted from MIT-licensed code, MIT License, Copyright (c) 2026 Dillon Mulroy; see THIRD_PARTY_NOTICES.
 * Our changes: bun:test's `mock.module` counts as module mocking, a doc comment on the rule, and a default export for the plugin's index.
 */
import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import { resolveVariable } from "../shared/scope.ts";

/** The test frameworks' objects that mock modules, by the module they come from, and their mocking methods. */
const MODULE_MOCKERS: readonly { readonly source: string; readonly name: string; readonly methods: ReadonlySet<string> }[] = [
	{ source: "bun:test", name: "mock", methods: new Set(["module"]) },
	{ source: "vitest", name: "vi", methods: new Set(["doMock", "mock"]) },
	{ source: "@jest/globals", name: "jest", methods: new Set(["doMock", "mock", "unstable_mockModule"]) },
];

/** The frameworks whose object is a global when nothing declares it. */
const GLOBAL_MOCKERS = new Set(["vi", "jest"]);

function importedName(node: ESTree.Node): string | null {
	if (node.type !== "ImportSpecifier") return null;
	return node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
}

/** The framework object an expression names, as `MODULE_MOCKERS` lists it, or undefined for anything else. */
function mockerOf(sourceCode: SourceCode, expression: ESTree.Expression): (typeof MODULE_MOCKERS)[number] | undefined {
	if (expression.type !== "Identifier") return undefined;
	const variable = resolveVariable(sourceCode, expression);
	if (variable === null || variable.defs.length === 0) {
		return GLOBAL_MOCKERS.has(expression.name) ? MODULE_MOCKERS.find((mocker) => mocker.name === expression.name) : undefined;
	}
	for (const definition of variable.defs) {
		if (definition.type !== "ImportBinding" || definition.parent?.type !== "ImportDeclaration") continue;
		const source = definition.parent.source.value;
		const name = importedName(definition.node);
		const mocker = MODULE_MOCKERS.find((candidate) => candidate.source === source && candidate.name === name);
		if (mocker !== undefined) return mocker;
	}
	return undefined;
}

function calledMethod(callee: ESTree.MemberExpression): string | null {
	const property = callee.property;
	if (!callee.computed) return property.type === "Identifier" ? property.name : null;
	return property.type === "Literal" && typeof property.value === "string" ? property.value : null;
}

function isModuleMockCall(sourceCode: SourceCode, callee: ESTree.Expression): boolean {
	if (callee.type !== "MemberExpression") return false;
	const mocker = mockerOf(sourceCode, callee.object);
	const method = calledMethod(callee);
	return mocker !== undefined && method !== null && mocker.methods.has(method);
}

/**
 * No test mocks a module (`mock.module`, `vi.mock`, `jest.mock`): a test replaces a dependency through a real seam, a
 * parameter or a faithful test implementation, so it tests the code as it runs.
 */
export default defineRule({
	meta: {
		type: "problem",
		docs: { description: "Disallow module mocking; tests replace dependencies through real interfaces." },
		messages: {
			moduleMock: "Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.",
		},
	},
	createOnce(context) {
		return {
			CallExpression(node) {
				if (node.callee.type === "Super" || node.callee.type === "V8IntrinsicExpression") return;
				if (isModuleMockCall(context.sourceCode, node.callee)) context.report({ node, messageId: "moduleMock" });
			},
		};
	},
});
