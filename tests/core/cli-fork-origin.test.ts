import { describe, it, expect } from "vitest";
import { isForkOrigin } from "../../src/cli.js";

describe("isForkOrigin — marketplace clone must point at the fork", () => {
  it("accepts fork origin URL variants", () => {
    expect(isForkOrigin("https://github.com/wotjr1649/context-mode.git")).toBe(true);
    expect(isForkOrigin("https://github.com/wotjr1649/context-mode")).toBe(true);
    expect(isForkOrigin("git@github.com:wotjr1649/context-mode.git")).toBe(true);
    expect(isForkOrigin("  https://github.com/wotjr1649/context-mode.git\n")).toBe(true);
  });
  it("rejects upstream and unrelated origins", () => {
    expect(isForkOrigin("https://github.com/mksglu/context-mode.git")).toBe(false);
    expect(isForkOrigin("https://github.com/attacker/context-mode.git")).toBe(false);
    expect(isForkOrigin("https://github.com/wotjr1649/other-repo.git")).toBe(false);
    expect(isForkOrigin("")).toBe(false);
    expect(isForkOrigin(undefined as unknown as string)).toBe(false);
  });
});
