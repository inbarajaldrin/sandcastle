// Parallel Planner — three-phase orchestration loop
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):    An opus agent analyzes open issues, builds a dependency
//                      graph, and outputs a <plan> JSON listing unblocked issues
//                      with their target branch names.
//   Phase 2 (Execute): N sonnet agents run in parallel via Promise.allSettled,
//                      each working a single issue on its own branch.
//   Phase 3 (Merge):   A sonnet agent merges all branches that produced commits.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.
//
// Usage:
//   npx tsx .sandcastle/main.mts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.mts" }

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// ---------------------------------------------------------------------------
// Plan output schema
//
// `Output.object` extracts the planner's <plan> JSON from stdout and validates
// it against a Standard Schema (https://standardschema.dev) validator. We
// hand-roll a tiny one below so this template depends only on
// `@ai-hero/sandcastle`. It should be trivial to swap in Zod instead — delete
// everything down to `planSchema` and write:
//
//   import { z } from "zod";
//   const planSchema = z.object({
//     issues: z.array(
//       z.object({ id: z.string(), title: z.string(), branch: z.string() }),
//     ),
//   });
// ---------------------------------------------------------------------------

interface PlanIssue {
  id: string;
  title: string;
  branch: string;
}

// The slice of the Standard Schema interface that `Output.object` consumes.
// The optional `types` field is phantom — it carries the inferred output type
// so `plan.output` is typed, but is never present at runtime.
interface PlanStandardSchema {
  "~standard": {
    version: 1;
    vendor: string;
    validate: (
      value: unknown,
    ) => { value: { issues: PlanIssue[] } } | { issues: { message: string }[] };
    types?: { input: unknown; output: { issues: PlanIssue[] } };
  };
}

const asString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
};

const planSchema: PlanStandardSchema = {
  "~standard": {
    version: 1,
    vendor: "sandcastle-template",
    validate: (value) => {
      try {
        if (typeof value !== "object" || value === null) {
          throw new Error("plan must be a JSON object");
        }
        const issues = (value as { issues?: unknown }).issues;
        if (!Array.isArray(issues)) {
          throw new Error("plan.issues must be an array");
        }
        return {
          value: {
            issues: issues.map((issue, i) => {
              if (typeof issue !== "object" || issue === null) {
                throw new Error(`plan.issues[${i}] must be an object`);
              }
              const record = issue as Record<string, unknown>;
              return {
                id: asString(record.id, `plan.issues[${i}].id`),
                title: asString(record.title, `plan.issues[${i}].title`),
                branch: asString(record.branch, `plan.issues[${i}].branch`),
              };
            }),
          },
        };
      } catch (error) {
        return {
          issues: [
            {
              message:
                error instanceof Error ? error.message : "Invalid plan output",
            },
          ],
        };
      }
    },
  },
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 10;

// Hooks run inside the sandbox before the agent starts each iteration.
// npm install ensures the sandbox always has fresh dependencies.
const hooks = {
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};

// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full npm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
const copyToWorktree = ["node_modules"];

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // -------------------------------------------------------------------------
  // Phase 1: Plan
  //
  // The planning agent (opus, for deeper reasoning) reads the open issue list,
  // builds a dependency graph, and selects the issues that can be worked in
  // parallel right now (i.e., no blocking dependencies on other open issues).
  //
  // It outputs a <plan> JSON block — Output.object parses and validates it.
  // -------------------------------------------------------------------------
  const plan = await sandcastle.run({
    hooks,
    sandbox: docker(),
    name: "planner",
    // One iteration is enough: the planner just needs to read and reason,
    // not write code. (Structured output requires maxIterations: 1.)
    maxIterations: 1,
    // Opus for planning: dependency analysis benefits from deeper reasoning.
    agent: sandcastle.claudeCode("claude-opus-4-7"),
    promptFile: "./.sandcastle/plan-prompt.md",
    // Extract and validate the <plan> JSON into a typed object. Throws
    // StructuredOutputError if the tag is missing, the JSON is malformed, or
    // validation fails — which aborts the loop.
    output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
  });

  const issues = plan.output.issues;

  if (issues.length === 0) {
    // No unblocked work — either everything is done or everything is blocked.
    console.log("No unblocked issues to work on. Exiting.");
    break;
  }

  console.log(
    `Planning complete. ${issues.length} issue(s) to work in parallel:`,
  );
  for (const issue of issues) {
    console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  // -------------------------------------------------------------------------
  // Phase 2: Execute
  //
  // Spawn one sonnet agent per issue, all running concurrently.
  // Each agent works on its own branch so there are no conflicts during
  // execution — merging happens in Phase 3.
  //
  // Promise.allSettled means one failing agent doesn't cancel the others.
  // -------------------------------------------------------------------------
  const settled = await Promise.allSettled(
    issues.map((issue) =>
      sandcastle.run({
        hooks,
        copyToWorktree,
        // Each agent starts on its own branch via branchStrategy on run().
        sandbox: docker(),
        branchStrategy: { type: "branch", branch: issue.branch },
        name: "implementer",
        // Give each agent plenty of room to implement and iterate on tests.
        maxIterations: 100,
        // Sonnet for execution: fast and capable enough for typical issue work.
        agent: sandcastle.claudeCode("claude-sonnet-4-6"),
        promptFile: "./.sandcastle/implement-prompt.md",
        // Prompt arguments substitute {{TASK_ID}}, {{ISSUE_TITLE}},
        // and {{BRANCH}} placeholders in implement-prompt.md before the
        // agent sees the prompt.
        promptArgs: {
          TASK_ID: issue.id,
          ISSUE_TITLE: issue.title,
          BRANCH: issue.branch,
        },
      }),
    ),
  );

  // Log any agents that threw (network error, sandbox crash, etc.).
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(
        `  ✗ ${issues[i]!.id} (${issues[i]!.branch}) failed: ${outcome.reason}`,
      );
    }
  }

  // Only pass branches that actually produced commits to the merge phase.
  // An agent that ran successfully but made no commits has nothing to merge.
  const completedIssues = settled
    .map((outcome, i) => ({ outcome, issue: issues[i]! }))
    .filter(
      (
        entry,
      ): entry is {
        outcome: PromiseFulfilledResult<
          Awaited<ReturnType<typeof sandcastle.run>>
        >;
        issue: (typeof issues)[number];
      } =>
        entry.outcome.status === "fulfilled" &&
        entry.outcome.value.commits.length > 0,
    )
    .map((entry) => entry.issue);

  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(
    `\nExecution complete. ${completedBranches.length} branch(es) with commits:`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    // All agents ran but none made commits — nothing to merge this cycle.
    console.log("No commits produced. Nothing to merge.");
    continue;
  }

  // -------------------------------------------------------------------------
  // Phase 3: Merge
  //
  // One sonnet agent merges all completed branches into the current branch,
  // resolving any conflicts and running tests to confirm everything still works.
  //
  // The {{BRANCHES}} and {{ISSUES}} prompt arguments are lists that the agent
  // uses to know which branches to merge and which issues to close.
  // -------------------------------------------------------------------------
  await sandcastle.run({
    hooks,
    sandbox: docker(),
    name: "merger",
    maxIterations: 1,
    // Sonnet is sufficient for merge conflict resolution.
    agent: sandcastle.claudeCode("claude-sonnet-4-6"),
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      // A markdown list of branch names, one per line.
      BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
      // A markdown list of issue IDs and titles, one per line.
      ISSUES: completedIssues.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
    },
  });

  console.log("\nBranches merged.");
}

console.log("\nAll done.");
