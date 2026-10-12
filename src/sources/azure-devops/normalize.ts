import type { CiState } from '../../kinds';
import type { CiObservation } from '../scm/provider';
import { isObject, num, str, type Json } from '../scm/json';

// Unknown values count as failure so a new Azure DevOps value is looked at, not taken as passing.
const BUILD_STATES: Readonly<Record<string, CiState>> = {
  none: 'pending',
  notStarted: 'pending',
  postponed: 'pending',
  inProgress: 'running',
  cancelling: 'running',
  succeeded: 'success',
  // Some steps failed; reporting it as passing would hide them.
  partiallySucceeded: 'failure',
  failed: 'failure',
  canceled: 'cancelled',
};

const BUILD_STEPS: Readonly<Record<string, number>> = { none: 0, notStarted: 0, postponed: 0, inProgress: 1, cancelling: 2, completed: 3 };

const STATUS_STATES: Readonly<Record<string, CiState>> = {
  notSet: 'pending',
  pending: 'pending',
  succeeded: 'success',
  failed: 'failure',
  error: 'failure',
  partiallySucceeded: 'failure',
  notApplicable: 'neutral',
};

/**
 * A pipeline build of a pull request, reported on `sha`. A PR build runs on the
 * merge commit, so the caller works out which PR head the build was for.
 */
export function readBuildObservation(repository: string, sha: string, build: Json): CiObservation | null {
  const id = num(build, 'id');
  const status = str(build, 'status');
  const name = isObject(build.definition) ? str(build.definition, 'name') : null;
  if (id === null || status === null || name === null) return null;
  const detail = status === 'completed' ? (str(build, 'result') ?? status) : status;
  return {
    repository,
    sha,
    check: 'build',
    name,
    state: BUILD_STATES[detail] ?? 'failure',
    detail,
    deliveryKey: `build:${repository}:${id}:${detail}`,
    order: [id, BUILD_STEPS[status] ?? 0],
    occurredAt: str(build, 'finishTime') ?? str(build, 'startTime') ?? str(build, 'queueTime'),
    url: isObject(build._links) && isObject(build._links.web) ? str(build._links.web, 'href') : null,
  };
}

/** A status posted to a commit (Git statuses API). */
export function readStatusObservation(repository: string, sha: string, status: Json): CiObservation | null {
  const id = num(status, 'id');
  const state = str(status, 'state');
  const context = isObject(status.context) ? status.context : null;
  const contextName = context ? str(context, 'name') : null;
  if (id === null || state === null || context === null || contextName === null) return null;
  const genre = str(context, 'genre');
  return {
    repository,
    sha,
    check: 'status',
    name: genre ? `${genre}/${contextName}` : contextName,
    state: STATUS_STATES[state] ?? 'failure',
    detail: state,
    // Status ids count up per commit, so the commit is part of the key.
    deliveryKey: `status:${repository}@${sha}:${id}`,
    order: [id, 0],
    occurredAt: str(status, 'updatedDate') ?? str(status, 'creationDate'),
    url: str(status, 'targetUrl'),
  };
}

/**
 * The PR head a build ran for: `triggerInfo['pr.sourceSha']` when the pipeline
 * reports it, else the PR's current head if the build ran on the PR's current
 * merge commit. null when neither tells, and the build is then not reported.
 */
export function buildHeadSha(build: Json, pr: Json): string | null {
  const fromTrigger = isObject(build.triggerInfo) ? str(build.triggerInfo, 'pr.sourceSha') : null;
  if (fromTrigger !== null) return fromTrigger;
  const mergeCommit = isObject(pr.lastMergeCommit) ? str(pr.lastMergeCommit, 'commitId') : null;
  const sourceVersion = str(build, 'sourceVersion');
  return mergeCommit !== null && sourceVersion === mergeCommit ? sourceHeadSha(pr) : null;
}

export function sourceHeadSha(pr: Json): string | null {
  return isObject(pr.lastMergeSourceCommit) ? str(pr.lastMergeSourceCommit, 'commitId') : null;
}
