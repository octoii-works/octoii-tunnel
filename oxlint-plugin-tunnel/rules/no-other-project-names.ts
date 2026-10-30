import { defineRule } from "@oxlint/plugins";

/** Other projects the repository's comments never name: what is adapted from one says so only in its MIT notice. */
const OTHER_PROJECTS = /\b(?:opencode|pi-mono|pi-ai|pi-coding-agent|chord|ngrok|tailscale|cloudflared|frp|celld)\b/i;

/** An MIT notice, whose words a wrapped block comment may split across lines. */
const MIT_NOTICE = /\bMIT[\s*]+License\b/;

/**
 * No comment names another project, except a comment that carries an adapted file's MIT notice: the code describes
 * itself, and where it came from belongs to that notice and the package's `THIRD_PARTY_NOTICES`.
 */
export default defineRule({
	meta: { type: "suggestion", docs: { description: "Disallow other projects' names in comments outside MIT notices." } },
	create(context) {
		return {
			Program() {
				for (const comment of context.sourceCode.getAllComments()) {
					const name = OTHER_PROJECTS.exec(comment.value)?.[0];
					if (name === undefined || MIT_NOTICE.test(comment.value)) continue;
					context.report({
						node: comment,
						message: `Comments do not name other projects (${name}); an adapted file says where it came from in its MIT notice.`,
					});
				}
			},
		};
	},
});
