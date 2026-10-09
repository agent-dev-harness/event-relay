import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { RelayEvent } from '../src/contract';
import { CI_STATUS_CHANGED, PR_HEAD_CHANGED, type CiStatusChanged, type PrHeadChanged } from '../src/kinds/index';
import { GitHubSource } from '../src/sources/github/index';

const SECRET = 'test-secret';
const SHA = 'a'.repeat(40);
const REPOSITORY = { full_name: 'o/r', html_url: 'https://github.com/o/r' };

function sign(body: Buffer, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function checkRunPayload(id: number, status: string, conclusion: string | null = null) {
  return {
    action: status === 'completed' ? 'completed' : 'created',
    check_run: {
      id,
      name: 'build',
      head_sha: SHA,
      status,
      conclusion,
      html_url: `https://github.com/o/r/runs/${id}`,
      started_at: '2026-01-01T00:00:00Z',
      completed_at: status === 'completed' ? '2026-01-01T00:05:00Z' : null,
      pull_requests: [{ number: 7 }],
    },
    repository: REPOSITORY,
  };
}

function statusPayload(id: number, state: string) {
  return { id, sha: SHA, context: 'ci/legacy', state, target_url: null, updated_at: '2026-01-01T00:00:00Z', repository: REPOSITORY };
}

function pullRequestPayload(action: string, head: string, before?: string) {
  return {
    action,
    number: 7,
    ...(before === undefined ? {} : { before, after: head }),
    pull_request: { number: 7, head: { sha: head, ref: 'feature' }, updated_at: '2026-01-01T00:00:00Z', html_url: 'https://github.com/o/r/pull/7' },
    repository: REPOSITORY,
  };
}

function started(options: { maxPayloadBytes?: number } = {}) {
  const source = new GitHubSource({ webhookSecret: SECRET, ...options });
  const emitted: RelayEvent[] = [];
  const controller = new AbortController();
  source.start({ emit: (e) => emitted.push(e), signal: controller.signal });
  const deliver = (eventName: string, payload: unknown, signature?: string) => {
    const body = Buffer.from(JSON.stringify(payload));
    return source.receive({ eventName, signature: signature ?? sign(body), body });
  };
  return { source, emitted, deliver, controller };
}

describe('GitHubSource', () => {
  it('emits a ci.status_changed event for each change of a check run', () => {
    const { emitted, deliver } = started();

    expect(deliver('check_run', checkRunPayload(1, 'queued')).status).toBe(202);
    deliver('check_run', checkRunPayload(1, 'completed', 'failure'));

    expect(emitted.map((e) => [e.kind, (e.data as CiStatusChanged).from, (e.data as CiStatusChanged).to])).toEqual([
      [CI_STATUS_CHANGED, null, 'pending'],
      [CI_STATUS_CHANGED, 'pending', 'failure'],
    ]);
    expect(emitted[1]).toMatchObject({
      id: 'github:check_run:1:failure',
      subject: { type: 'commit', key: `github.com/o/r@${SHA}` },
      occurredAt: '2026-01-01T00:05:00Z',
      data: { repository: 'github.com/o/r', sha: SHA, check: 'check_run', detail: 'failure' },
    });
  });

  it('maps GitHub states onto CiState, keeping GitHub\'s own name in detail', () => {
    const { emitted, deliver } = started();

    deliver('check_run', checkRunPayload(1, 'in_progress'));
    deliver('check_run', checkRunPayload(1, 'completed', 'timed_out'));
    deliver('check_run', checkRunPayload(2, 'completed', 'some_new_conclusion'));
    deliver('status', statusPayload(3, 'error'));

    expect(emitted.map((e) => [(e.data as CiStatusChanged).to, (e.data as CiStatusChanged).detail])).toEqual([
      ['running', 'in_progress'],
      ['failure', 'timed_out'],
      ['failure', 'error'],
    ]);
  });

  it('reports a check only when its CiState changes', () => {
    const { emitted, deliver } = started();

    deliver('check_run', checkRunPayload(1, 'queued'));
    expect(deliver('check_run', checkRunPayload(1, 'waiting')).message).toBe('no change');

    expect(emitted).toHaveLength(1);
  });

  it('names the repository by host, so the same path on two hosts stays apart', () => {
    const { emitted, deliver } = started();

    deliver('status', { ...statusPayload(1, 'success'), repository: { full_name: 'o/r', html_url: 'https://ghe.example.com/o/r' } });

    expect(emitted[0]!.subject.key).toBe(`ghe.example.com/o/r@${SHA}`);
  });

  it('keeps the check name, which third parties write, out of data', () => {
    const { emitted, deliver } = started();
    deliver('check_run', checkRunPayload(1, 'queued'));

    expect(emitted[0]!.untrusted).toEqual({ name: 'build' });
    expect(JSON.stringify(emitted[0]!.data)).not.toContain('build');
  });

  it('emits nothing when the state has not changed', () => {
    const { emitted, deliver } = started();
    deliver('status', statusPayload(1, 'pending'));
    expect(deliver('status', statusPayload(2, 'pending')).message).toBe('no change');
    deliver('status', statusPayload(3, 'success'));

    expect(emitted.map((e) => [e.id, (e.data as CiStatusChanged).to])).toEqual([
      ['github:status:1', 'pending'],
      ['github:status:3', 'success'],
    ]);
  });

  it('still reports a change whose emit threw when it is redelivered', () => {
    const source = new GitHubSource({ webhookSecret: SECRET });
    const emitted: RelayEvent[] = [];
    let fail = true;
    source.start({
      emit: (e) => {
        if (fail) throw new Error('relay refused');
        emitted.push(e);
      },
      signal: new AbortController().signal,
    });
    const body = Buffer.from(JSON.stringify(statusPayload(1, 'pending')));

    expect(() => source.receive({ eventName: 'status', signature: sign(body), body })).toThrow('relay refused');
    fail = false;
    source.receive({ eventName: 'status', signature: sign(body), body });

    expect(emitted).toHaveLength(1);
  });

  describe('pr.head_changed', () => {
    const OLD = 'b'.repeat(40);
    const NEW = 'c'.repeat(40);

    it('reports the head of an opened PR, then each push to it', () => {
      const { emitted, deliver } = started();

      deliver('pull_request', pullRequestPayload('opened', OLD));
      deliver('pull_request', pullRequestPayload('synchronize', NEW, OLD));

      expect(emitted.map((e) => [e.kind, e.subject, e.data])).toEqual([
        [PR_HEAD_CHANGED, { type: 'pull_request', key: 'github.com/o/r#7' }, { repository: 'github.com/o/r', number: 7, from: null, to: OLD, url: 'https://github.com/o/r/pull/7' }],
        [PR_HEAD_CHANGED, { type: 'pull_request', key: 'github.com/o/r#7' }, { repository: 'github.com/o/r', number: 7, from: OLD, to: NEW, url: 'https://github.com/o/r/pull/7' }],
      ]);
    });

    it('gives a redelivered push the same id, and a push back to an earlier head a new one', () => {
      const { emitted, deliver } = started();

      deliver('pull_request', pullRequestPayload('synchronize', NEW, OLD));
      deliver('pull_request', pullRequestPayload('synchronize', NEW, OLD));
      deliver('pull_request', pullRequestPayload('synchronize', OLD, NEW));

      expect(emitted.map((e) => e.id)).toEqual([
        `github:pull_request:github.com/o/r#7:${OLD}..${NEW}`,
        `github:pull_request:github.com/o/r#7:${OLD}..${NEW}`,
        `github:pull_request:github.com/o/r#7:${NEW}..${OLD}`,
      ]);
      expect((emitted[2]!.data as PrHeadChanged).to).toBe(OLD);
    });

    it('ignores pull_request actions that do not move the head', () => {
      const { emitted, deliver } = started();

      expect(deliver('pull_request', pullRequestPayload('edited', OLD)).message).toBe('ignored');
      expect(deliver('pull_request', pullRequestPayload('closed', OLD)).message).toBe('ignored');
      expect(deliver('pull_request', pullRequestPayload('synchronize', OLD, OLD)).message).toBe('no change');
      expect(emitted).toEqual([]);
    });
  });

  describe('out-of-order deliveries', () => {
    const states = (emitted: RelayEvent[]) => emitted.map((e) => [(e.data as CiStatusChanged).from, (e.data as CiStatusChanged).to]);

    it('drops a check run update that arrives after a later one', () => {
      const { emitted, deliver } = started();

      deliver('check_run', checkRunPayload(1, 'queued'));
      deliver('check_run', checkRunPayload(1, 'completed', 'success'));
      expect(deliver('check_run', checkRunPayload(1, 'in_progress')).message).toBe('stale');

      expect(states(emitted)).toEqual([[null, 'pending'], ['pending', 'success']]);
    });

    it('drops an earlier run of the same check, but reports a re-run', () => {
      const { emitted, deliver } = started();

      deliver('check_run', checkRunPayload(2, 'completed', 'failure'));
      expect(deliver('check_run', checkRunPayload(1, 'completed', 'success')).message).toBe('stale');
      deliver('check_run', checkRunPayload(3, 'queued'));

      expect(states(emitted)).toEqual([[null, 'failure'], ['failure', 'pending']]);
    });

    it('drops a commit status older than the last one', () => {
      const { emitted, deliver } = started();

      deliver('status', statusPayload(2, 'success'));
      expect(deliver('status', statusPayload(1, 'pending')).message).toBe('stale');

      expect(states(emitted)).toEqual([[null, 'success']]);
    });
  });

  it('ignores events it does not turn into changes', () => {
    const { emitted, deliver } = started();
    expect(deliver('ping', { zen: 'hi', repository: REPOSITORY })).toEqual({ status: 202, message: 'ignored' });
    expect(deliver('check_run', { repository: REPOSITORY, check_run: { id: 1 } }).message).toBe('ignored');
    expect(emitted).toEqual([]);
  });

  it('refuses a delivery with a missing or wrong signature', () => {
    const { emitted, deliver } = started();
    const body = Buffer.from(JSON.stringify(checkRunPayload(1, 'queued')));
    expect(deliver('check_run', checkRunPayload(1, 'queued'), sign(body, 'wrong')).status).toBe(401);
    expect(deliver('check_run', checkRunPayload(1, 'queued'), '').status).toBe(401);
    expect(emitted).toEqual([]);
  });

  it('refuses a body larger than maxPayloadBytes before parsing it', () => {
    const { deliver } = started({ maxPayloadBytes: 10 });
    expect(deliver('check_run', checkRunPayload(1, 'queued')).status).toBe(413);
  });

  it('refuses deliveries once the relay stops it', () => {
    const { deliver, controller } = started();
    controller.abort();
    expect(deliver('check_run', checkRunPayload(1, 'queued')).status).toBe(503);
  });

  describe('handler', () => {
    let server: Server | undefined;
    afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

    async function listen(source: GitHubSource): Promise<string> {
      server = createServer(source.handler);
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`;
    }

    it('accepts a signed webhook over HTTP', async () => {
      const { source, emitted } = started();
      const url = await listen(source);
      const body = Buffer.from(JSON.stringify(checkRunPayload(1, 'queued')));

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'x-github-event': 'check_run', 'x-hub-signature-256': sign(body) },
        body,
      });

      expect(res.status).toBe(202);
      expect(emitted).toHaveLength(1);
    });

    it('answers 413 to an oversized body', async () => {
      const { source, emitted } = started({ maxPayloadBytes: 10 });
      const url = await listen(source);

      const res = await fetch(url, { method: 'POST', headers: { 'x-github-event': 'check_run' }, body: 'x'.repeat(1_000) });

      expect(res.status).toBe(413);
      expect(emitted).toEqual([]);
    });
  });
});
