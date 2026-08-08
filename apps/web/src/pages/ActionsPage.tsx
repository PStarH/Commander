import { useMemo, useState } from 'react';
import {
  Ban,
  Check,
  FileCheck2,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Shield,
  X,
} from 'lucide-react';
import { Badge, Button, Input, Select } from '../components/ui';
import {
  ActionGatewayClient,
  ActionGatewayError,
  type ActionCompensationApprovalRequestV1,
  type ActionCompensationRequestResponseV1,
  type ActionCompensationRequestV1,
  type ActionEvidenceV1,
  type ActionKillSwitchScopeV1,
  type ActionKillSwitchV1,
  type ActionProposeRequestV1,
  type ActionSimulationV1,
  type GovernedActionV1,
} from '../api/actions';

interface ActionsPageProps {
  token: string;
}

const INITIAL_REQUEST: ActionProposeRequestV1 = {
  source: 'web-console',
  package: 'commander.web',
  model: 'none',
  tool: 'ticket.create',
  destination: 'servicenow://sandbox/incidents',
  effectType: 'connector.servicenow.incident.create',
  args: {},
  idempotencyKey: '',
};

function statusVariant(state: string): 'success' | 'warning' | 'error' | 'info' {
  if (state === 'SUCCEEDED') return 'success';
  if (state === 'FAILED' || state === 'ESCALATED') return 'error';
  if (state === 'COMPLETION_UNKNOWN' || state.includes('APPROVAL')) return 'warning';
  return 'info';
}

function failureMessage(error: unknown): string {
  if (error instanceof ActionGatewayError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : 'Action request failed';
}

function operationKey(operation: string, subject: string): string {
  return `web:${operation}:${subject}:${crypto.randomUUID()}`;
}

export function ActionsPage({ token }: ActionsPageProps) {
  const client = useMemo(() => new ActionGatewayClient({ token }), [token]);
  const [request, setRequest] = useState<ActionProposeRequestV1>(INITIAL_REQUEST);
  const [argsText, setArgsText] = useState('{}');
  const [runId, setRunId] = useState('');
  const [simulation, setSimulation] = useState<ActionSimulationV1 | null>(null);
  const [action, setAction] = useState<GovernedActionV1 | null>(null);
  const [approvalDigest, setApprovalDigest] = useState('');
  const [evidence, setEvidence] = useState<ActionEvidenceV1 | null>(null);
  const [compensation, setCompensation] = useState<ActionCompensationRequestResponseV1 | null>(
    null,
  );
  const [compensationAdapterVersion, setCompensationAdapterVersion] = useState('demo.adapter.v1');
  const [compensationEffectType, setCompensationEffectType] = useState(
    'compensate.demo.ticket.create',
  );
  const [compensationPatchText, setCompensationPatchText] = useState('{}');
  const [forwardReceiptHash, setForwardReceiptHash] = useState('');
  const [compensationAuthorizationId, setCompensationAuthorizationId] = useState('');
  const [compensationActionDigest, setCompensationActionDigest] = useState('');
  const [compensationPolicySnapshotId, setCompensationPolicySnapshotId] = useState('');
  const [killSwitches, setKillSwitches] = useState<ActionKillSwitchV1[]>([]);
  const [killScope, setKillScope] = useState<ActionKillSwitchScopeV1>('effect-type');
  const [killValue, setKillValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function payload(): ActionProposeRequestV1 {
    const args: unknown = JSON.parse(argsText);
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error('args must be a JSON object');
    }
    return { ...request, args: args as Record<string, unknown> };
  }

  async function perform(operation: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (nextError) {
      setError(failureMessage(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function simulate() {
    await perform(async () => {
      const result = await client.simulateAction(payload());
      setSimulation(result.simulation);
      setApprovalDigest(result.simulation.actionDigest);
    });
  }

  async function propose() {
    await perform(async () => {
      const result = await client.proposeAction(payload());
      setAction(result.action);
      setRunId(result.action.runId);
      setSimulation(result.action.simulation);
      setApprovalDigest(result.action.actionDigest);
    });
  }

  async function loadAction() {
    await perform(async () => {
      const loaded = await client.getAction(runId);
      setAction(loaded);
      setSimulation(loaded.simulation);
      setApprovalDigest(loaded.actionDigest);
      setEvidence(null);
    });
  }

  async function review(approved: boolean) {
    if (!action) return;
    await perform(async () => {
      const updated = approved
        ? await client.approveAction(
            action.runId,
            {
              actionDigest: approvalDigest,
              simulationId: action.simulation.simulationId,
              policySnapshotId: action.policySnapshotId,
            },
            operationKey('approve', action.runId),
          )
        : await client.rejectAction(action.runId, undefined, operationKey('reject', action.runId));
      setAction(updated);
    });
  }

  async function reconcile() {
    if (!action) return;
    await perform(async () => {
      await client.reconcileAction(action.runId, operationKey('reconcile', action.runId));
      setAction(await client.getAction(action.runId));
    });
  }

  async function verifyEvidence() {
    if (!action) return;
    await perform(async () => setEvidence(await client.getActionEvidence(action.runId)));
  }

  async function requestCompensation() {
    if (!action) return;
    await perform(async () => {
      const patch: unknown = JSON.parse(compensationPatchText);
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('Compensation patch must be a JSON object');
      }
      const input: ActionCompensationRequestV1 = {
        originalEffectId: action.effectId,
        adapterVersion: compensationAdapterVersion,
        compensationEffectType,
        compensationPatch: patch as Record<string, unknown>,
        forwardReceiptHash,
      };
      const result = await client.requestCompensation(
        action.runId,
        input,
        operationKey('compensation-request', action.runId),
      );
      setCompensation(result);
      if ('authorization' in result && result.authorization) {
        setCompensationAuthorizationId(result.authorization.id);
        setCompensationActionDigest(result.authorization.actionDigest);
        setCompensationPolicySnapshotId(result.authorization.policySnapshotId);
      }
    });
  }

  async function approveCompensation() {
    if (!action || !compensationAuthorizationId) return;
    await perform(async () => {
      const input: ActionCompensationApprovalRequestV1 = {
        actionDigest: compensationActionDigest,
        policySnapshotId: compensationPolicySnapshotId,
      };
      const result = await client.approveCompensation(
        action.runId,
        compensationAuthorizationId,
        input,
        operationKey('compensation-approve', compensationAuthorizationId),
      );
      setCompensation(result);
    });
  }

  async function refreshKillSwitches() {
    await perform(async () => setKillSwitches(await client.listKillSwitches()));
  }

  async function enableKillSwitch() {
    if (!killValue.trim()) return;
    await perform(async () => {
      await client.setKillSwitch(
        { scope: killScope, value: killValue, enabled: true },
        operationKey('kill-enable', `${killScope}:${killValue}`),
      );
      setKillSwitches(await client.listKillSwitches());
    });
  }

  const approvalMatches = Boolean(action && approvalDigest === action.actionDigest);

  return (
    <div className="page actions-page">
      <div className="page-head">
        <div>
          <div className="section-label">Operations</div>
          <h1>Actions</h1>
        </div>
        <div className="actions-lookup">
          <Input
            value={runId}
            onChange={(event) => setRunId(event.target.value)}
            placeholder="Run ID"
            aria-label="Run ID"
          />
          <Button
            variant="secondary"
            onClick={loadAction}
            disabled={busy || !runId.trim()}
            title="Load action"
          >
            <Search size={15} />
            Load
          </Button>
        </div>
      </div>

      {error ? <div className="banner error">{error}</div> : null}

      <section className="actions-band">
        <div className="actions-band-head">
          <h2>Proposal</h2>
          {simulation ? (
            <Badge
              variant={
                simulation.effect === 'deny'
                  ? 'error'
                  : simulation.effect === 'require_approval'
                    ? 'warning'
                    : 'success'
              }
            >
              {simulation.effect}
            </Badge>
          ) : null}
        </div>
        <div className="actions-form-grid">
          <label>
            Tool
            <Input
              value={request.tool}
              onChange={(event) =>
                setRequest((current) => ({ ...current, tool: event.target.value }))
              }
            />
          </label>
          <label>
            Effect type
            <Input
              value={request.effectType}
              onChange={(event) =>
                setRequest((current) => ({ ...current, effectType: event.target.value }))
              }
            />
          </label>
          <label>
            Destination
            <Input
              value={request.destination}
              onChange={(event) =>
                setRequest((current) => ({ ...current, destination: event.target.value }))
              }
            />
          </label>
          <label>
            Idempotency key
            <Input
              value={request.idempotencyKey}
              onChange={(event) =>
                setRequest((current) => ({ ...current, idempotencyKey: event.target.value }))
              }
            />
          </label>
          <label className="actions-json-field">
            Arguments
            <textarea
              value={argsText}
              onChange={(event) => setArgsText(event.target.value)}
              spellCheck={false}
            />
          </label>
        </div>
        <div className="actions-command-row">
          <Button
            variant="secondary"
            onClick={simulate}
            disabled={busy || !request.idempotencyKey.trim()}
          >
            <Play size={15} />
            Simulate
          </Button>
          <Button onClick={propose} disabled={busy || !request.idempotencyKey.trim()}>
            <Send size={15} />
            Propose
          </Button>
          {simulation ? <code>{simulation.actionDigest}</code> : null}
        </div>
      </section>

      {action ? (
        <section className="actions-band">
          <div className="actions-band-head">
            <div>
              <h2>{action.runId}</h2>
              <code>{action.actionDigest}</code>
            </div>
            <Badge variant={statusVariant(action.state)}>{action.state}</Badge>
          </div>

          {action.state === 'AWAITING_APPROVAL' ? (
            <div className="actions-review-row">
              <Shield size={18} />
              <Input
                value={approvalDigest}
                onChange={(event) => setApprovalDigest(event.target.value)}
                aria-label="Approval action digest"
              />
              <Button
                onClick={() => review(true)}
                disabled={busy || !approvalMatches}
                title="Approve exact digest"
              >
                <Check size={15} />
                Approve
              </Button>
              <Button variant="danger" onClick={() => review(false)} disabled={busy}>
                <X size={15} />
                Reject
              </Button>
            </div>
          ) : null}

          {action.state === 'COMPLETION_UNKNOWN' ? (
            <div className="actions-command-row">
              <Button onClick={reconcile} disabled={busy}>
                <RefreshCw size={15} />
                Reconcile
              </Button>
            </div>
          ) : null}

          {['SUCCEEDED', 'FAILED', 'ESCALATED'].includes(action.state) ? (
            <div className="actions-command-row">
              <Button variant="secondary" onClick={verifyEvidence} disabled={busy}>
                <FileCheck2 size={15} />
                Verify evidence
              </Button>
              {evidence ? (
                <Badge variant={evidence.verification.ok ? 'success' : 'error'}>
                  {evidence.verification.ok ? 'verified' : 'invalid'}
                </Badge>
              ) : null}
            </div>
          ) : null}

          {action.state === 'SUCCEEDED' ? (
            <div className="actions-compensation">
              <div className="actions-band-head">
                <h3>Compensation</h3>
                {compensation && 'state' in compensation ? (
                  <Badge variant="warning">{compensation.state}</Badge>
                ) : null}
                {compensation && 'accepted' in compensation && compensation.accepted ? (
                  <Badge variant="success">accepted</Badge>
                ) : null}
              </div>
              <div className="actions-form-grid">
                <label>
                  Adapter version
                  <Input
                    value={compensationAdapterVersion}
                    onChange={(event) => setCompensationAdapterVersion(event.target.value)}
                  />
                </label>
                <label>
                  Compensation effect type
                  <Input
                    value={compensationEffectType}
                    onChange={(event) => setCompensationEffectType(event.target.value)}
                  />
                </label>
                <label>
                  Forward receipt hash
                  <Input
                    value={forwardReceiptHash}
                    onChange={(event) => setForwardReceiptHash(event.target.value)}
                  />
                </label>
                <label className="actions-json-field">
                  Compensation patch
                  <textarea
                    value={compensationPatchText}
                    onChange={(event) => setCompensationPatchText(event.target.value)}
                    spellCheck={false}
                  />
                </label>
              </div>
              <div className="actions-command-row">
                <Button
                  variant="secondary"
                  onClick={requestCompensation}
                  disabled={busy || !forwardReceiptHash.trim()}
                >
                  <RotateCcw size={15} />
                  Request compensation
                </Button>
              </div>
              {compensationAuthorizationId ? (
                <div className="actions-review-row">
                  <Input
                    value={compensationAuthorizationId}
                    onChange={(event) => setCompensationAuthorizationId(event.target.value)}
                    aria-label="Compensation authorization ID"
                  />
                  <Input
                    value={compensationActionDigest}
                    onChange={(event) => setCompensationActionDigest(event.target.value)}
                    aria-label="Compensation action digest"
                  />
                  <Input
                    value={compensationPolicySnapshotId}
                    onChange={(event) => setCompensationPolicySnapshotId(event.target.value)}
                    aria-label="Compensation policy snapshot ID"
                  />
                  <Button
                    onClick={approveCompensation}
                    disabled={busy || !compensationActionDigest || !compensationPolicySnapshotId}
                  >
                    <Check size={15} />
                    Approve compensation
                  </Button>
                </div>
              ) : null}
              {compensation ? (
                <pre className="actions-result">{JSON.stringify(compensation, null, 2)}</pre>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="actions-band">
        <div className="actions-band-head">
          <h2>Kill switches</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={refreshKillSwitches}
            disabled={busy}
            title="Refresh kill switches"
          >
            <RefreshCw size={14} />
          </Button>
        </div>
        <div className="actions-kill-row">
          <Select
            value={killScope}
            onChange={(event) => setKillScope(event.target.value as ActionKillSwitchScopeV1)}
            aria-label="Kill switch scope"
          >
            {['tenant', 'package', 'model', 'tool', 'destination', 'effect-type'].map((scope) => (
              <option key={scope} value={scope}>
                {scope}
              </option>
            ))}
          </Select>
          <Input
            value={killValue}
            onChange={(event) => setKillValue(event.target.value)}
            placeholder="Value"
            aria-label="Kill switch value"
          />
          <Button variant="danger" onClick={enableKillSwitch} disabled={busy || !killValue.trim()}>
            <Ban size={15} />
            Enable
          </Button>
        </div>
        <div className="actions-switch-list">
          {killSwitches.map((item) => (
            <div key={`${item.scope}:${item.value}`}>
              <code>
                {item.scope}:{item.value}
              </code>
              <Badge variant={item.enabled ? 'error' : 'info'}>
                {item.enabled ? 'enabled' : 'disabled'}
              </Badge>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
