export interface PackageContextRepo {
  readonly name: string;
  readonly packageName: string;
  readonly repoPath: string;
  readonly cloneUrl: string;
  readonly refsForVersion: (cleanVersion: string) => ReadonlyArray<string>;
}

export const PACKAGE_CONTEXT_REPOS = [
  {
    name: "effect",
    packageName: "effect",
    repoPath: ".context/effect",
    cloneUrl: "https://github.com/Effect-TS/effect.git",
    refsForVersion: (version: string) => [`effect@${version}`],
  },
  {
    name: "pi",
    packageName: "@earendil-works/pi-coding-agent",
    repoPath: ".context/pi",
    cloneUrl: "https://github.com/earendil-works/pi.git",
    refsForVersion: (version: string) => [
      `@earendil-works/pi-coding-agent@${version}`,
      `pi-coding-agent@${version}`,
      `v${version}`,
      version,
    ],
  },
] as const satisfies ReadonlyArray<PackageContextRepo>;
