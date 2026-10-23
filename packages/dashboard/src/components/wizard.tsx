// The provision wizard's screens (spec 11 §11.3 item 3, 11.5 step 2; the steps and rules are
// state/wizard.ts). It runs the calls — network_get / network_set, profile_list, device_provision — and
// follows the job through `/ws` job frames, with job_get every 1.5 s as the fallback (and once more when
// a frame ended it, for the result or error a frame does not carry). The Wi-Fi form is shared with the
// Network page; its password is sent once and never shown.

import { useEffect, useReducer, useState } from 'react';

import type { PortInfo } from '@fractonica/protocol/browser';

import { OpError } from '../api/rest.ts';
import type { NetworkView } from '../api/types.ts';
import { useAct, useLive } from '../hooks.ts';
import { hubClock, live, rest } from '../runtime.ts';
import { portHolder } from '../state/format.ts';
import { pendingPrompts } from '../state/live.ts';
import {
  canSubmit,
  networkInput,
  needsJobDetail,
  networkProblem,
  promptForWizard,
  provisionInput,
  stageView,
  WIZARD_CLOSED,
  wizardDeviceId,
  wizardReducer,
  type ProfileOption,
  type WizardKnown,
  type WizardState,
} from '../state/wizard.ts';
import { Badge, Button, Field, Input, KV, Mono, Progress, Select } from './ui.tsx';

const JOB_POLL_MS = 1500;

/** network_set: SSID, write-only password, country and BSSID. */
export function NetworkForm({ current, onSaved }: { current?: NetworkView | null; onSaved?: (n: NetworkView) => void }) {
  const [f, setF] = useState({ ssid: current?.ssid ?? '', password: '', country: current?.country ?? '', bssid: current?.bssid ?? '' });
  const act = useAct('network_set', { done: (n) => `Wi-Fi set: ${n.ssid}`, refresh: ['network_get'] });
  const problem = networkProblem(f);
  return (
    <form
      className="grid max-w-md gap-3"
      data-form="network"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) {
          act.mutate(networkInput(f), {
            onSuccess: (n) => {
              setF((x) => ({ ...x, password: '' }));
              onSaved?.(n);
            },
          });
        }
      }}
    >
      <Field label="SSID">
        <Input value={f.ssid} onChange={(e) => setF({ ...f, ssid: e.target.value })} maxLength={32} autoComplete="off" />
      </Field>
      <Field label="Password" hint={current?.password_set ? 'a password is stored; leave empty to keep it' : 'empty for an open network'}>
        <Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} maxLength={64} autoComplete="new-password" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Country" hint="2 letters, optional">
          <Input value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })} maxLength={2} />
        </Field>
        <Field label="BSSID" hint="pin one AP, optional">
          <Input value={f.bssid} onChange={(e) => setF({ ...f, bssid: e.target.value })} placeholder="aa:bb:cc:dd:ee:ff" />
        </Field>
      </div>
      {problem && f.ssid ? <p className="text-xs text-bad">{problem}</p> : null}
      <div>
        <Button type="submit" tone="primary" disabled={!!problem || act.isPending}>
          Save network
        </Button>
      </div>
    </form>
  );
}

/** The profiles to offer: profile_list, else the profiles of the debug artifacts. */
async function loadProfiles(): Promise<ProfileOption[]> {
  try {
    const r = await rest.op('profile_list', {});
    return r.profiles.map((p) => ({ profile: p.profile, board: p.board, chip: p.chip, built: p.newest_debug !== undefined }));
  } catch {
    const r = await rest.op('artifact_list', { build_type: 'debug', limit: 100 });
    const seen = new Set<string>();
    return r.artifacts.filter((a) => !a.fault && !seen.has(a.profile) && seen.add(a.profile)).map((a) => ({ profile: a.profile, built: true }));
  }
}

function Stages({ s }: { s: WizardState }) {
  const icon = { done: '✓', current: '•', failed: '✕', pending: '·' } as const;
  const tone = { done: 'text-ok', current: 'text-accent font-semibold', failed: 'text-bad font-semibold', pending: 'text-muted' } as const;
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm" data-stages>
      {stageView(s).map((x) => (
        <li key={x.stage} className={tone[x.status]} data-stage={x.stage} data-stage-status={x.status}>
          {icon[x.status]} {x.stage}
        </li>
      ))}
    </ol>
  );
}

export function ProvisionWizard({ port, known, onClose }: { port: PortInfo; known: WizardKnown | null; onClose: () => void }) {
  const [s, dispatch] = useReducer(wizardReducer, WIZARD_CLOSED);
  const prompts = useLive((st) => st.prompts);

  // Open on this port, and read what the steps need.
  useEffect(() => {
    dispatch({ type: 'open', port: { path: port.path, usb_serial: port.usb_serial, device_id: port.device_id, state: port.state, holder: portHolder(port) }, known });
    let gone = false;
    rest.op('network_get', {}).then(
      (n) => !gone && dispatch({ type: 'network', network: { state: 'set', ssid: n.ssid } }),
      (e: unknown) =>
        !gone &&
        dispatch({ type: 'network', network: e instanceof OpError && e.code === 'NOT_FOUND' ? { state: 'missing' } : { state: 'error', error: e instanceof Error ? e.message : String(e) } }),
    );
    loadProfiles().then(
      (p) => !gone && dispatch({ type: 'profiles', profiles: p }),
      () => !gone && dispatch({ type: 'profiles', profiles: [] }),
    );
    return () => {
      gone = true;
    };
    // The wizard is keyed by port: a port row's later refreshes do not restart it.
  }, [port.path]);

  // Follow the job: `/ws` job frames, job_get as the fallback, and device.online for the board.
  const jobId = s.job?.job_id;
  const running = s.step === 'flash' && jobId !== undefined && !s.error;
  useEffect(() => {
    if (!jobId || !running) {
      return;
    }
    const off = live.listen({
      job: (f) => f.job_id === jobId && dispatch({ type: 'job', job: f }),
    });
    const t = setInterval(() => {
      rest.op('job_get', { job_id: jobId }).then(
        (j) => dispatch({ type: 'job', job: j, full: true }),
        () => {},
      );
    }, JOB_POLL_MS);
    return () => {
      off();
      clearInterval(t);
    };
  }, [jobId, running]);
  // A job frame ended it: its result (or the hub's error) comes from job_get.
  const detail = needsJobDetail(s);
  useEffect(() => {
    if (detail && jobId) {
      rest.op('job_get', { job_id: jobId }).then(
        (j) => dispatch({ type: 'job', job: j, full: true }),
        () => {},
      );
    }
  }, [detail, jobId]);
  // A board that said HELLO over USB is online before the wizard knew its id: ask once the job is done.
  const doneId = s.step === 'done' && !s.online ? s.result?.device_id : undefined;
  useEffect(() => {
    if (doneId) {
      rest.op('device_get', { device: `id:${doneId}` }).then(
        (d) => d.presence === 'online' && dispatch({ type: 'online', device_id: doneId }),
        () => {},
      );
    }
  }, [doneId]);
  useEffect(() => {
    if (s.step !== 'flash' && s.step !== 'done') {
      return;
    }
    return live.listen({
      events: (batch, info) => {
        if (!info.snapshot) {
          for (const e of batch) {
            if (e.type === 'device.online' && e.device) {
              dispatch({ type: 'online', device_id: e.device });
            }
          }
        }
      },
    });
  }, [s.step]);

  const submit = () => {
    dispatch({ type: 'submitted' });
    rest.op('device_provision', provisionInput(s)).then(
      (job) => dispatch({ type: 'job', job, full: true }),
      (e: unknown) => dispatch({ type: 'failed', error: e instanceof OpError ? e.toToolError() : { code: 'INTERNAL', message: String(e), retryable: false } }),
    );
  };

  const prompt = Object.values(prompts).find((p) => promptForWizard(s, p) && pendingPrompts({ prompts }, hubClock.now()).includes(p));
  const title = known ? `Provision ${known.alias}` : 'Provision a new board';
  return (
    <section className="rounded-lg border-2 border-accent/50 bg-panel p-4" data-wizard data-step={s.step}>
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">{['detect', 'network', 'profile', 'flash', 'done'].map((x) => (x === s.step ? `[${x}]` : x)).join(' → ')}</span>
          <Button tone="ghost" onClick={onClose} aria-label="close">
            ×
          </Button>
        </div>
      </header>

      {s.step === 'detect' ? (
        <div className="flex flex-col gap-3">
          <KV
            items={[
              ['port', <Mono key="p">{port.path}</Mono>],
              ['USB serial', <Mono key="u">{port.usb_serial ?? '–'}</Mono>],
              ['board', known ? `${known.alias} (${known.profile ?? 'no profile'}, ${known.presence ?? 'unknown'})` : 'new: the registry has not seen it'],
              ['held by', portHolder(port)],
            ]}
          />
          {port.state === 'busy_external' ? <p className="text-sm text-warn">Another program holds this port: close it first, or provisioning fails with PORT_BUSY_EXTERNAL.</p> : null}
          <div>
            <Button tone="primary" onClick={() => dispatch({ type: 'next' })} disabled={s.network.state === 'loading'}>
              Next
            </Button>
          </div>
        </div>
      ) : null}

      {s.step === 'network' ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm">The hub has no Wi-Fi network for its nodes yet. Set it once; every board you provision joins it.</p>
          {s.network.state === 'error' ? <p className="text-sm text-bad">{s.network.error}</p> : null}
          <NetworkForm onSaved={(n) => dispatch({ type: 'network', network: { state: 'set', ssid: n.ssid } })} />
          <div>
            <Button tone="ghost" onClick={() => dispatch({ type: 'back' })}>
              Back
            </Button>
          </div>
        </div>
      ) : null}

      {s.step === 'profile' ? (
        <form
          className="flex max-w-lg flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit(s)) {
              submit();
            }
          }}
        >
          <Field label="Profile" hint={s.profiles === null ? 'loading…' : 'auto: the one profile built for the board’s chip'}>
            <Select
              value={s.profile}
              onChange={(v) => dispatch({ type: 'profile', profile: v })}
              options={[
                { value: '', label: 'auto' },
                ...(s.profiles ?? []).map((p) => ({ value: p.profile, label: `${p.profile}${p.chip ? ` (${p.chip})` : ''}${p.built ? '' : ' — not built'}` })),
              ]}
            />
          </Field>
          <Field label="Alias" error={s.aliasError} hint={known ? `now ${known.alias}` : 'empty: <profile>-<last 6 hex of the MAC>'}>
            <Input value={s.alias} onChange={(e) => dispatch({ type: 'alias', alias: e.target.value })} placeholder="pad-red-1" maxLength={31} data-input="alias" />
          </Field>
          <p className="text-xs text-muted">Wi-Fi: {s.network.state === 'set' ? s.network.ssid : 'not set'}. Provisioning erases what the board runs and flashes the newest debug build.</p>
          <div className="flex gap-2">
            <Button tone="ghost" onClick={() => dispatch({ type: 'back' })}>
              Back
            </Button>
            <Button type="submit" tone="primary" disabled={!canSubmit(s)} data-action="provision">
              Provision
            </Button>
          </div>
        </form>
      ) : null}

      {s.step === 'flash' || s.step === 'done' ? (
        <div className="flex flex-col gap-3">
          <Stages s={s} />
          {s.step === 'flash' && !s.error ? <Progress pct={s.job?.stage === 'flash' ? s.job.progress?.pct : undefined} /> : null}
          {s.job?.progress?.message && s.step === 'flash' ? <p className="text-xs text-muted">{s.job.progress.message}</p> : null}
          {prompt ? <p className="rounded bg-warn/15 px-3 py-2 text-sm font-semibold">{prompt.text}</p> : null}
          {s.error ? (
            <div className="rounded border border-bad/40 bg-bad/5 px-3 py-2 text-sm" role="alert" data-error={s.error.code}>
              <p>
                <span className="font-semibold text-bad">{s.error.code}</span> {s.error.message}
              </p>
              {s.error.human.length ? (
                <ul className="mt-1 list-disc pl-5">
                  {s.error.human.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
              ) : null}
              {s.error.candidates.length ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span>Pick the profile:</span>
                  {s.error.candidates.map((c) => (
                    <Button key={c} onClick={() => dispatch({ type: 'pick', profile: c })}>
                      {c}
                    </Button>
                  ))}
                </div>
              ) : null}
              <div className="mt-2 flex gap-2">
                <Button onClick={() => dispatch({ type: 'back' })}>Back</Button>
                {!s.error.candidates.length ? (
                  <Button tone="primary" onClick={submit} data-action="retry">
                    Retry
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {s.step === 'done' && !s.result && s.job?.detail ? (
            <div className="flex gap-2" data-result="unknown">
              <span className="self-center text-sm text-muted">Provisioned; the job returned no result.</span>
              <Button tone="primary" onClick={onClose}>
                Done
              </Button>
            </div>
          ) : null}
          {s.step === 'done' && s.result ? (
            <div className="flex flex-col gap-2" data-result={s.result.wifi}>
              <KV
                items={[
                  ['alias', <span key="a" className="font-semibold">{s.result.alias}</span>],
                  ['profile · firmware', `${s.result.profile} · ${s.result.fw_id.slice(0, 8)}`],
                  ['Wi-Fi', s.result.wifi === 'joined' ? <Badge key="w" tone="ok">joined</Badge> : <Badge key="w" tone="warn">not joined</Badge>],
                  ['online', s.online ? <Badge key="o" tone="ok">online</Badge> : <Badge key="o">waiting</Badge>],
                ]}
              />
              {s.result.wifi !== 'joined' ? (
                <p className="text-sm text-warn">It said HELLO over USB but not over Wi-Fi: check the network (Network page) and its log on its device page.</p>
              ) : null}
              {s.result.warnings?.map((w) => (
                <p key={w} className="text-xs text-warn">
                  {w}
                </p>
              ))}
              <div className="flex gap-2">
                <Button tone="primary" onClick={onClose}>
                  Done
                </Button>
                <span className="self-center text-xs text-muted">{wizardDeviceId(s)}</span>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
