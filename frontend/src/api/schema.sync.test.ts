// @vitest-environment node
/** `schema.d.ts` is exactly what `npm run gen:api` makes from the committed `openapi.json`. The
 * backend's tests/test_openapi_snapshot.py pins that JSON to the live app, so together the two
 * keep the generated types — and the contract in contract.check.ts — true to the backend. */
import { readFileSync } from "node:fs";
import openapiTS, { astToString } from "openapi-typescript";
import { describe, expect, it } from "vitest";

const here = new URL(".", import.meta.url);

describe("generated API types", () => {
  it("match the committed OpenAPI snapshot (run `npm run gen:api` if not)", async () => {
    const generated = astToString(await openapiTS(new URL("openapi.json", here)));
    const committed = readFileSync(new URL("schema.d.ts", here), "utf8");
    // The CLI prepends an "auto-generated" banner; compare from the first declaration on.
    expect(committed.slice(committed.indexOf("export interface paths"))).toBe(generated);
  });
});
