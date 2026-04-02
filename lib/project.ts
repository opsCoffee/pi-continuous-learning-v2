import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import type { ProjectInfo } from "./types.js";

const execFileAsync = promisify(execFile);

async function runGit(args: string[], cwd?: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", args, {
			cwd,
			timeout: 5000,
		});
		const value = stdout.trim();
		return value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

function stripRemoteCredentials(remote: string | undefined): string | undefined {
	if (!remote) {
		return undefined;
	}
	return remote.replace(/:\/\/[^@]+@/u, "://");
}

export async function detectProject(cwd: string): Promise<ProjectInfo> {
	const resolvedCwd = resolve(cwd);
	const gitRoot = (await runGit(["-C", resolvedCwd, "rev-parse", "--show-toplevel"])) ?? resolvedCwd;
	const remote = stripRemoteCredentials(await runGit(["-C", gitRoot, "remote", "get-url", "origin"]));
	const projectHashSource = remote ?? gitRoot;
	const id = createHash("sha256").update(projectHashSource).digest("hex").slice(0, 12);
	const name = basename(gitRoot) || "project";
	return {
		id,
		name,
		root: gitRoot,
		remote,
	};
}
