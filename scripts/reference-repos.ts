// Libraries agents read as source in `.repos/`. `ref` is the branch or tag to clone; when `versionOf`
// names a dependency we pin, `tag` turns that version into the library's tag so the source matches.
export interface ReferenceRepo {
  id: string;
  url: string;
  ref: string;
  versionOf?: string;
  tag?: (version: string) => string;
}

export const referenceRepos: ReferenceRepo[] = [
  // Pinned to the installed version via `versionOf`/`tag` once a package depends on effect.
  { id: "effect", url: "https://github.com/Effect-TS/effect.git", ref: "main" },
  // The repo now carries only the 2.0 line (for the migration spike, issue #2). The 0.94 we run ships its
  // TypeScript source in node_modules/alchemy/src, so read that for current behaviour.
  { id: "alchemy", url: "https://github.com/alchemy-run/alchemy.git", ref: "main" },
  { id: "better-auth", url: "https://github.com/better-auth/better-auth.git", ref: "main" },
  { id: "t3code", url: "https://github.com/pingdotgg/t3code.git", ref: "main" },
];
