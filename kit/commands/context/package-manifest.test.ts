import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import {
  getDependencyVersion,
  MissingDependencyError,
  stripLeadingVersionRange,
} from "./package-manifest";

describe("context package version helpers", () => {
  it("strips leading range markers used by package.json", () => {
    expect(stripLeadingVersionRange("^3.21.3")).toBe("3.21.3");
    expect(stripLeadingVersionRange("~3.21.3")).toBe("3.21.3");
    expect(stripLeadingVersionRange("3.21.3")).toBe("3.21.3");
  });

  it("reads dependency versions from dependencies before devDependencies", () => {
    const version = getDependencyVersion(
      {
        dependencies: { effect: "^3.21.3" },
        devDependencies: { effect: "^0.0.0" },
      },
      "effect",
    );

    expect(version).toBe("3.21.3");
  });

  it("throws a tagged error when a dependency is missing", () => {
    expect(() =>
      getDependencyVersion({ dependencies: {} }, "effect"),
    ).toThrowError(MissingDependencyError);

    try {
      getDependencyVersion({ dependencies: {} }, "effect");
      expect.unreachable("expected getDependencyVersion to throw");
    } catch (error) {
      expect(error).toHaveProperty("_tag", "MissingDependencyError");
      expect(error).toHaveProperty(
        "message",
        "Missing dependency effect in package.json",
      );
    }
  });
});
