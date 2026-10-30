import { ruleTester } from "../test/harness.ts";

const NAME = "require-safety-comment-for-type-assertion";
const rule = ruleTester(NAME);
const MESSAGE = "This type assertion has no `SAFETY:` justification. State the checked invariant immediately before the assertion or its containing statement.";
const INVARIANT_MESSAGE =
	"This type assertion has no `INVARIANT:` justification. State the checked invariant immediately before the assertion or its containing statement.";

const invariant = ruleTester(NAME, { options: [{ markers: ["INVARIANT"] }], label: `${NAME} (INVARIANT marker)` });
invariant.valid("a comment with the configured marker", "// INVARIANT: The caller parsed this value.\nconst value = input as User;");
invariant.invalid(
	"a SAFETY comment when only INVARIANT is configured",
	"// SAFETY: This marker is not configured.\nconst value = input as User;",
	INVARIANT_MESSAGE,
);
invariant.invalid("a configured marker with no reason", "// INVARIANT:   \nconst value = input as User;", INVARIANT_MESSAGE);

const either = ruleTester(NAME, { options: [{ markers: ["INVARIANT", "SAFETY"] }], label: `${NAME} (INVARIANT and SAFETY markers)` });
either.valid("a comment with the second configured marker", "// SAFETY: The caller parsed this value.\nconst value = input as User;");

const symbol = ruleTester(NAME, { options: [{ markers: ["SAFE+"] }], label: `${NAME} (SAFE+ marker)` });
symbol.valid("a marker with a regular-expression character", "// SAFE+: The caller parsed this value.\nconst value = input as User;");

rule.valid("an as const assertion", "const values = [1, 2] as const;");
rule.valid("an angle-bracket const assertion", "const value = <const>{ id: 'one' };");
rule.valid("a SAFETY comment before the statement", "// SAFETY: The parser established the UserId invariant.\nconst id = value as UserId;");
rule.valid(
	"a SAFETY comment before a return",
	"function parse(): UserId {\n// SAFETY: Validation above established the UserId invariant.\nreturn value as UserId;\n}",
);
rule.valid("an inline SAFETY comment before the assertion", "const id = /* SAFETY: Validation established the invariant. */ value as UserId;");
rule.valid("a SAFETY comment before an export", "// SAFETY: The parser established the exported UserId invariant.\nexport const id = value as UserId;");
rule.valid(
	"a SAFETY block comment wrapped across lines",
	"/* SAFETY:\n * The parser established the exported UserId invariant.\n */\nexport const id = value as UserId;",
);

rule.invalid("an as assertion with no comment", "const id = value as UserId;", MESSAGE);
rule.invalid("an angle-bracket assertion with no comment", "const id = <UserId>value;", MESSAGE);
rule.invalid("a SAFETY comment after the assertion", "const id = value as UserId; // SAFETY: Too late.", MESSAGE);
rule.invalid("a comment without the marker", "// This cast seems fine.\nconst id = value as UserId;", MESSAGE);
rule.invalid("a marker with no reason", "// SAFETY:\nconst id = value as UserId;", MESSAGE);
rule.invalid("a marker followed only by spaces", "// SAFETY:   \nconst id = value as UserId;", MESSAGE);
rule.invalid("an empty inline marker", "const id = /* SAFETY: */ value as UserId;", MESSAGE);
rule.invalid("an exported assertion with no comment", "export const id = value as UserId;", MESSAGE);
rule.invalid("an exported assertion with a comment without the marker", "// This is not a safety justification.\nexport const id = value as UserId;", MESSAGE);
