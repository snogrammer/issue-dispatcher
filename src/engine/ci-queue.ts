import type { GiteaClient } from "../gitea/client.js";
import type { RepoRef, RunStatus } from "../gitea/types.js";
import { silentLogger, type Logger } from "../log.js";

/**
 * How busy Gitea Actions is across the watched repos. The runners are shared
 * and few, so every PR the dispatcher pushes competes with everything else;
 * when CI is backed up, starting another Claude run only adds to the queue.
 *
 * The engine checks this once per poll and doesn't *start* runs while busy.
 * It never holds back a push from a run that already finished: those commits
 * would otherwise sit unpushed in a workspace. With at most
 * MAX_CONCURRENT_SESSIONS runs in flight, the overshoot is bounded.
 *
 * Gitea reports a run waiting for a runner as `queued` and one on a runner as
 * `in_progress` (`waiting` is for runs needing approval). Unknown status
 * filters are rejected with 400 rather than ignored (checked on 1.27).
 */

export type CiQueueGitea = Pick<GiteaClient, "countWorkflowRuns">;

const ACTIVE: readonly RunStatus[] = ["queued", "in_progress", "waiting"];

export interface CiLoad {
  active: number;
  busy: boolean;
}

export class CiQueue {
  /** Repos whose counts are failing, so the warning is logged once, not every poll. */
  private readonly failing = new Set<string>();

  constructor(
    private readonly gitea: CiQueueGitea,
    /** Read on every check, so a change from the dashboard applies at the next poll. */
    private readonly maxActive: () => number,
    private readonly log: Logger = silentLogger,
  ) {}

  /**
   * Active runs across `repos`. A repo whose count fails is skipped (and
   * logged): a flaky API call shouldn't stall all work.
   */
  async load(repos: RepoRef[]): Promise<CiLoad> {
    let active = 0;
    for (const repo of repos) {
      const name = `${repo.owner}/${repo.name}`;
      try {
        for (const status of ACTIVE) active += await this.gitea.countWorkflowRuns(repo, status);
        if (this.failing.delete(name)) this.log.info("counting Actions runs again", { repo: name });
      } catch (error) {
        // E.g. 403 when Actions is disabled for the repo or the token can't read it.
        if (!this.failing.has(name)) {
          this.failing.add(name);
          this.log.warn("can't count Actions runs; ignoring this repo's CI load", {
            repo: name,
            error,
          });
        }
      }
    }
    return { active, busy: active >= this.maxActive() };
  }
}
