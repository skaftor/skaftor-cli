// Readable aliases for the project's repository registry MCP tools (code-sync spec-2b S7).
// The server owns scope, permission checks, storage allowance and promotion; this module only maps arguments.
export const reposHelp = (bold) => `${bold("REPOSITORIES")}
  repos ls [--tier active|lazy|excluded] [--page n]  List repositories (50 per page, pages 1–100)
  repos track <owner/name>                         Ask the platform to mirror a known repository
                                                   Use provider:owner/name to disambiguate`;

export async function runRepos(sub, rest, flags, { conn, callTool, printToolResult }) {
  const usage = "usage: skaftor repos ls [--tier active|lazy|excluded] [--page 1-100] [--json], or skaftor repos track <owner/name> [--json]";
  const allowed = sub === "ls" ? ["tier", "page", "json"] : ["json"];
  if (Object.keys(flags).some((k) => !allowed.includes(k))) throw new Error(usage);
  let tool, args;
  if (sub === "ls") {
    if (rest.length) throw new Error(usage);
    args = {};
    if (flags.tier !== undefined) {
      if (!["active", "lazy", "excluded"].includes(flags.tier)) throw new Error("--tier must be active, lazy or excluded");
      args.tier = flags.tier;
    }
    if (flags.page !== undefined) {
      const page = Number(flags.page);
      if (typeof flags.page !== "string" || !/^[0-9]+$/.test(flags.page) || !Number.isSafeInteger(page) || page < 1 || page > 100) throw new Error("--page must be a whole number from 1 to 100");
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
