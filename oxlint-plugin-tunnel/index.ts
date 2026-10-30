/**
 * The tunnel's own lint rules, which check what the repository asks of its code that oxlint's rules do not: oxlint loads
 * this file as a JS plugin named `tunnel`.
 */
import { definePlugin } from "@oxlint/plugins";
import connectorNotAgent from "./rules/connector-not-agent.ts";
import disableNeedsReason from "./rules/disable-needs-reason.ts";
import noBooleanParameters from "./rules/no-boolean-parameters.ts";
import noChainedTypeAssertions from "./rules/no-chained-type-assertions.ts";
import noHostPlatform from "./rules/no-host-platform.ts";
import noModuleMocking from "./rules/no-module-mocking.ts";
import noOtherProjectNames from "./rules/no-other-project-names.ts";
import noUnexplainedSkips from "./rules/no-unexplained-skips.ts";
import noWidenThenAssert from "./rules/no-widen-then-assert.ts";
import requireExportDoc from "./rules/require-export-doc.ts";
import requireSafetyCommentForTypeAssertion from "./rules/require-safety-comment-for-type-assertion.ts";
import upperCaseConstants from "./rules/upper-case-constants.ts";

/** The plugin `tunnel`, with every rule of the repository's own. */
export default definePlugin({
	meta: { name: "tunnel" },
	rules: {
		"connector-not-agent": connectorNotAgent,
		"disable-needs-reason": disableNeedsReason,
		"no-boolean-parameters": noBooleanParameters,
		"no-chained-type-assertions": noChainedTypeAssertions,
		"no-host-platform": noHostPlatform,
		"no-module-mocking": noModuleMocking,
		"no-other-project-names": noOtherProjectNames,
		"no-unexplained-skips": noUnexplainedSkips,
		"no-widen-then-assert": noWidenThenAssert,
		"require-export-doc": requireExportDoc,
		"require-safety-comment-for-type-assertion": requireSafetyCommentForTypeAssertion,
		"upper-case-constants": upperCaseConstants,
	},
});
