import { describe, expect, test } from "vitest";
import { mfaAlways, mfaRequired, passwordProblem, type MfaPolicy } from "./policy";

describe("who needs two-step sign-in", () => {
  // [policy, admin home, admin away, member home, member away]
  test.each<[MfaPolicy, boolean, boolean, boolean, boolean]>([
    ["off", false, false, false, false],
    ["admins-away", false, true, false, false],
    ["admins", true, true, false, false],
    ["everyone-away", false, true, false, true],
    ["everyone", true, true, true, true],
  ])("%s", (policy, adminHome, adminAway, memberHome, memberAway) => {
    expect([mfaRequired("admin", "home", policy), mfaRequired("admin", "away", policy), mfaRequired("member", "home", policy), mfaRequired("member", "away", policy)]).toEqual([
      adminHome,
      adminAway,
      memberHome,
      memberAway,
    ]);
  });

  test("only the 'always' rules need setting up straight after signing in at home", () => {
    expect((["off", "admins-away", "admins", "everyone-away", "everyone"] as MfaPolicy[]).filter((p) => mfaAlways(p))).toEqual(["admins", "everyone"]);
  });
});

describe("password rules", () => {
  const base = { minLength: 8, notUsername: true, lettersAndNumbers: false };
  test.each([
    ["too short for the chosen minimum", "abc12", base, /at least 8/],
    ["fine once the minimum is lowered", "abc12", { ...base, minLength: 5 }, null],
    ["close to the username but not the same", "MaYa-1234", { ...base, minLength: 4 }, null],
    ["the username itself", "Maya1234", { ...base, minLength: 4 }, /other than your username/],
    ["allowed to match the username when that rule is off", "maya1234", { ...base, minLength: 4, notUsername: false }, null],
    ["letters only when letters and numbers are required", "correct horse battery", { ...base, lettersAndNumbers: true }, /letters and numbers/],
    ["a long phrase with a digit when they are", "correct horse battery 9", { ...base, lettersAndNumbers: true }, null],
    ["non-Latin letters count as letters", "日本の山へ行く2026", { ...base, lettersAndNumbers: true }, null],
  ] as const)("%s", (_, pw, policy, expected) => {
    const problem = passwordProblem(pw, "maya1234", policy);
    if (expected === null) expect(problem).toBeNull();
    else expect(problem).toMatch(expected);
  });
});
