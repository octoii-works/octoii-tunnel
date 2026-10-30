import { ruleTester } from "../test/harness.ts";

const rule = ruleTester("no-module-mocking");
const MESSAGE = "Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.";

rule.valid("a faithful test implementation", "const store = new InMemoryUserStore();");
rule.valid("a spy on an object", "vi.spyOn(store, 'save');");
rule.valid("a local object named vi", "const vi = { mock() {} }; vi.mock();");
rule.valid("a parameter named jest", "function test(jest: { mock(): void }) { jest.mock(); }");
rule.valid("a vi imported from elsewhere", "import { vi as localVi } from './helpers'; localVi.mock('./module');");
rule.valid("bun:test's mock of a function", "import { mock } from 'bun:test'; const handler = mock(() => 1);");
rule.valid("a mock.module whose mock is not bun:test's", "mock.module('./user-store');");

rule.invalid("a global vi.mock", "vi.mock('./user-store');", MESSAGE);
rule.invalid("a global jest.mock", "jest.mock('./user-store');", MESSAGE);
rule.invalid("a computed vi.doMock", "vi['doMock']('./user-store');", MESSAGE);
rule.invalid("jest.unstable_mockModule", "jest.unstable_mockModule('./user-store');", MESSAGE);
rule.invalid("vitest's vi.mock", "import { vi } from 'vitest'; vi.mock('./user-store');", MESSAGE);
rule.invalid("vitest's vi under another name", "import { vi as testApi } from 'vitest'; testApi.mock('./user-store');", MESSAGE);
rule.invalid("@jest/globals' jest.mock", "import { jest } from '@jest/globals'; jest.mock('./user-store');", MESSAGE);
rule.invalid("bun:test's mock.module", "import { mock } from 'bun:test'; mock.module('./user-store', () => ({}));", MESSAGE);
rule.invalid(
	"bun:test's mock.module under another name, computed",
	"import { mock as fake } from 'bun:test'; fake['module']('./user-store', () => ({}));",
	MESSAGE,
);
