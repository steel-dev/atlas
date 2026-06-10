import { execFileSync } from "node:child_process";

export interface CommitInfo {
  sha: string;
  shortSha: string;
  dirty: boolean;
  dirtyFiles: string[];
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function captureCommit(): CommitInfo {
  try {
    const sha = git(["rev-parse", "HEAD"]);
    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const dirtyFiles = porcelain
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    return {
      sha,
      shortSha: sha.slice(0, 10),
      dirty: dirtyFiles.length > 0,
      dirtyFiles,
    };
  } catch {
    return { sha: "unknown", shortSha: "unknown", dirty: false, dirtyFiles: [] };
  }
}
