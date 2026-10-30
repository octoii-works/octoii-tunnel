import { defineRule } from "@oxlint/plugins";

/** A comment that turns a lint rule off, whichever linter's spelling it uses. */
const DISABLE_DIRECTIVE = /^\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?\b/;

/** A directive's reason: what follows ` -- `. */
const REASON = /\s--\s+\S/;

/** A comment that silences the type checker, and the words after it, which are its reason. */
const TYPE_CHECK_DIRECTIVE = /^\s*\*?\s*@ts-(?:expect-error|ignore|nocheck)(?![\w-])(.*)$/s;

/**
 * Every comment that turns a lint rule off says why, after ` -- `, and every comment that silences the type checker
 * says why after the directive: a suppression without a reason cannot be judged when the code around it changes.
 */
export default defineRule({
	meta: {
		type: "suggestion",
		docs: { description: "Require a reason on every lint-disable and type-checker suppression comment." },
	},
	create(context) {
		return {
			Program() {
				for (const comment of context.sourceCode.getAllComments()) {
					if (DISABLE_DIRECTIVE.test(comment.value) && !REASON.test(comment.value)) {
						context.report({ node: comment, message: "Say why the rule is off, after ` -- `: `// oxlint-disable-next-line rule -- reason`." });
					}
					const typeCheckReason = TYPE_CHECK_DIRECTIVE.exec(comment.value)?.[1];
					if (typeCheckReason !== undefined && typeCheckReason.replace(/^[\s:-]+/, "").trim() === "") {
						context.report({ node: comment, message: "Say why the type checker is silenced, after the directive: `// @ts-expect-error reason`." });
					}
				}
			},
		};
	},
});
