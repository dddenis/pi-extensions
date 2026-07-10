import { Schema } from "effect";

export const PackageManifestSchema = Schema.Struct({
  dependencies: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
  devDependencies: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
});

export type PackageManifest = typeof PackageManifestSchema.Type;

export class MissingDependencyError extends Schema.TaggedError<MissingDependencyError>()(
  "MissingDependencyError",
  { packageName: Schema.String },
) {
  override get message(): string {
    return `Missing dependency ${this.packageName} in package.json`;
  }
}

export const stripLeadingVersionRange = (version: string): string =>
  version.replace(/^[\^~]/, "");

export const getDependencyVersion = (
  manifest: PackageManifest,
  packageName: string,
): string => {
  const version =
    manifest.dependencies?.[packageName] ??
    manifest.devDependencies?.[packageName];
  if (!version) {
    throw new MissingDependencyError({ packageName });
  }

  return stripLeadingVersionRange(version);
};
