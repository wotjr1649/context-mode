import { describe, it, expect } from "vitest";
import { isForkOrigin } from "../../src/cli.js";

describe("isForkOrigin — marketplace clone must point at the fork", () => {
  it("accepts fork origin URL variants", () => {
    expect(isForkOrigin("https://github.com/wotjr1649/ctxscribe.git")).toBe(true);
    expect(isForkOrigin("https://github.com/wotjr1649/ctxscribe")).toBe(true);
    expect(isForkOrigin("git@github.com:wotjr1649/ctxscribe.git")).toBe(true);
    expect(isForkOrigin("  https://github.com/wotjr1649/ctxscribe.git\n")).toBe(true);
    expect(isForkOrigin("https://token@github.com/wotjr1649/ctxscribe.git")).toBe(true); // embedded credentials
    expect(isForkOrigin("ssh://git@github.com/wotjr1649/ctxscribe.git")).toBe(true);
    expect(isForkOrigin("https://github.com:443/wotjr1649/ctxscribe.git")).toBe(true); // explicit port
  });
  it("rejects upstream and unrelated origins", () => {
    expect(isForkOrigin("https://github.com/mksglu/context-mode.git")).toBe(false);
    expect(isForkOrigin("https://github.com/attacker/context-mode.git")).toBe(false);
    expect(isForkOrigin("https://github.com/wotjr1649/other-repo.git")).toBe(false);
    // Honest host, honest owner, OLD repo name — the sharpest post-rename case:
    // a marketplace clone whose origin still points at the pre-rename repo.
    expect(isForkOrigin("https://github.com/wotjr1649/context-mode.git")).toBe(false);
    expect(isForkOrigin("")).toBe(false);
    expect(isForkOrigin(undefined as unknown as string)).toBe(false);
    // host-boundary bypass attempts — "github.com" as a substring must NOT match
    expect(isForkOrigin("https://evilgithub.com/wotjr1649/context-mode.git")).toBe(false);
    expect(isForkOrigin("https://github.com.evil.com/wotjr1649/context-mode")).toBe(false);
    // path-embedded "//" and "@" must NOT float the host off the real authority
    expect(isForkOrigin("https://evil.com//github.com/wotjr1649/context-mode.git")).toBe(false);
    expect(isForkOrigin("https://evil.com/x@github.com/wotjr1649/context-mode.git")).toBe(false);
    expect(isForkOrigin("file:///tmp/x//github.com/wotjr1649/context-mode.git")).toBe(false);
    expect(isForkOrigin("https://github.com@evil.com/wotjr1649/context-mode.git")).toBe(false); // userinfo trick
  });
});
