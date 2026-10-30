import { ruleTester } from "../test/harness.ts";

const rule = ruleTester("no-chained-type-assertions");
const MESSAGE = "This assertion chain discards type evidence. Keep the original precise type, or parse untrusted input at its boundary before narrowing it.";

rule.valid("a single assertion", "const value = input as User;");
rule.valid("a single parenthesized assertion", "const value = (input as User);");
rule.valid("a chain of const assertions", "const value = ({ id: 1 } as const) as const;");

rule.invalid("an as chain through unknown", "const value = input as unknown as User;", MESSAGE);
rule.invalid("a parenthesized as chain", "const value = (input as unknown) as User;", MESSAGE);
rule.invalid("an angle-bracket chain", "const value = <User>(<unknown>input);", MESSAGE);
rule.invalid("a const assertion asserted again", "const value = ({ id: 1 } as const) as User;", MESSAGE);
