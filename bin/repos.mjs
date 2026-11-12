// Readable aliases for the project's repository registry MCP tools (code-sync spec-2b S7).
// The server owns scope, permission checks, storage allowance and promotion; this module only maps arguments.
export const reposHelp = (bold) => `${bold("REPOSITORIES")}
  repos ls [--tier active|lazy|excluded] [--page n]  List repositories (50 per page, pages 1–100)
           [--q text] [--provider github|gitlab|bitbucket]  Narrow by part of the name, or by code host
           [--archived[=false]] [--stale[=false]]           Archived upstream / not seen by the last full listing
  repos track <owner/name>                         Ask the platform to mirror a known repository
                                                   Use provider:owner/name to disambiguate`;

export async function runRepos(sub, rest, flags, { conn, callTool, printToolResult }) {
  const usage = "usage: skaftor repos ls [--tier active|lazy|excluded] [--q text] [--provider github|gitlab|bitbucket] [--archived] [--stale] [--page 1-100] [--json], or skaftor repos track <owner/name> [--json]";
  const allowed = sub === "ls" ? ["tier", "q", "provider", "archived", "stale", "page", "json"] : ["json"];
  if (Object.keys(flags).some((k) => !allowed.includes(k))) throw new Error(usage);
  let tool, args;
  if (sub === "ls") {
    if (rest.length) throw new Error(usage);
    args = {};
    if (flags.tier !== undefined) {
      if (!["active", "lazy", "excluded"].includes(flags.tier)) throw new Error("--tier must be active, lazy or excluded");
      args.tier = flags.tier;
    }
    // The server's filters, so a large organisation can reach any row: past page 100 it says "narrow the list".
    if (flags.q !== undefined) {
      if (typeof flags.q !== "string" || !flags.q.trim() || flags.q.trim().length > 100) throw new Error("--q needs part of a repository name (1 to 100 characters)");
      args.q = flags.q.trim();
    }
    if (flags.provider !== undefined) {
      if (!["github", "gitlab", "bitbucket"].includes(flags.provider)) throw new Error("--provider must be github, gitlab or bitbucket");
      args.provider = flags.provider;
    }
    for (const k of ["archived", "stale"]) {
      if (flags[k] === undefined) continue;
      if (flags[k] !== true && flags[k] !== "true" && flags[k] !== "false") throw new Error(`--${k} takes no value, or true / false`);
      args[k] = flags[k] !== "false";
    }
    if (flags.page !== undefined) {
      const page = Number(flags.page);
      if (typeof flags.page !== "string" || !/^[0-9]+$/.test(flags.page) || !Number.isSafeInteger(page) || page < 1 || page > 100) throw new Error("--page must be a whole number from 1 to 100; narrow the list with --q, --provider, --tier, --archived or --stale to reach more");
      args.page = page;
    }
    tool = "repos_list";
  } else if (sub === "track") {
    if (rest.length !== 1 || !rest[0].trim()) throw new Error(usage);
    tool = "repos_track";
    args = { name: rest[0] };
  } else throw new Error(usage);
  return printToolResult(await callTool(conn, tool, args), !!flags.json);
}
