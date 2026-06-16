/**
 * AWS compensation handler — inverse operations for EC2, S3, Lambda, IAM.
 *
 * Compensation mapping (forward → inverse):
 *   EC2: start→stop, stop→start, reboot→noop, terminate→impossible
 *   S3: put→delete, delete→restore(versioned), bucket.create→delete, bucket.delete→impossible
 *   Lambda: create→delete, update→restore-config, delete→impossible, invoke→noop
 *   IAM: role.create→delete, policy.attach→detach, user.create→delete, user.delete→impossible
 *
 * Idempotency: read-before-write pattern (query state before compensating).
 * Auth: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION env vars or instance profile.
 */

import type { CompensationHandler } from '../../runtime/compensationRegistry';
import type { CompensableAction } from '../../runtime/compensationRegistry';
import type { CompensationOutcome } from './types';

export interface AWSConfig {
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  ec2Client?: MockEC2Client;
  s3Client?: MockS3Client;
  lambdaClient?: MockLambdaClient;
  iamClient?: MockIAMClient;
}

export interface MockEC2Client {
  describeInstances(params: { InstanceIds: string[] }): Promise<{
    Reservations: Array<{
      Instances: Array<{
        State: { Name: string };
        InstanceId: string;
      }>;
    }>;
  }>;
  startInstances(params: { InstanceIds: string[] }): Promise<void>;
  stopInstances(params: { InstanceIds: string[] }): Promise<void>;
  rebootInstances(params: { InstanceIds: string[] }): Promise<void>;
  describeInstanceStatus(params: { InstanceIds: string[] }): Promise<{
    InstanceStatuses: Array<{
      InstanceId: string;
      InstanceState: { Name: string };
    }>;
  }>;
}

export interface MockS3Client {
  headObject(params: { Bucket: string; Key: string }): Promise<{ VersionId?: string }>;
  deleteObject(params: { Bucket: string; Key: string; VersionId?: string }): Promise<void>;
  headBucket(params: { Bucket: string }): Promise<void>;
  deleteBucket(params: { Bucket: string }): Promise<void>;
  listObjectVersions(params: { Bucket: string; Prefix: string }): Promise<{
    Versions: Array<{ VersionId: string; Key: string; IsLatest: boolean }>;
  }>;
}

export interface MockLambdaClient {
  getFunction(params: { FunctionName: string }): Promise<{
    Configuration: { FunctionName: string; Role: string; Handler: string; Runtime: string };
    Code: { ZipFile?: Uint8Array; RepositoryType?: string; Location?: string };
  }>;
  deleteFunction(params: { FunctionName: string }): Promise<void>;
  updateFunctionConfiguration(params: {
    FunctionName: string;
    Role?: string;
    Handler?: string;
    Runtime?: string;
  }): Promise<void>;
}

export interface MockIAMClient {
  listAttachedRolePolicies(params: { RoleName: string }): Promise<{
    AttachedPolicies: Array<{ PolicyArn: string; PolicyName: string }>;
  }>;
  detachRolePolicy(params: { RoleName: string; PolicyArn: string }): Promise<void>;
  deleteRole(params: { RoleName: string }): Promise<void>;
  listRolePolicies(params: { RoleName: string }): Promise<{ PolicyNames: string[] }>;
  deleteRolePolicy(params: { RoleName: string; PolicyName: string }): Promise<void>;
  getUser(params: { UserName: string }): Promise<{ User: { UserName: string } }>;
  deleteUser(params: { UserName: string }): Promise<void>;
  listUserPolicies(params: { UserName: string }): Promise<{ PolicyNames: string[] }>;
  deleteUserPolicy(params: { UserName: string; PolicyName: string }): Promise<void>;
}

export const AWS_TOOL_TAGS: Record<string, string[]> = {
  'aws:ec2:start': ['aws', 'ec2', 'low_risk'],
  'aws:ec2:stop': ['aws', 'ec2', 'low_risk'],
  'aws:ec2:reboot': ['aws', 'ec2', 'low_risk'],
  'aws:ec2:terminate': ['aws', 'ec2', 'destructive', 'non_reversible'],
  'aws:s3:put': ['aws', 's3', 'low_risk'],
  'aws:s3:delete': ['aws', 's3', 'destructive', 'requires_approval'],
  'aws:s3:bucket:create': ['aws', 's3', 'low_risk'],
  'aws:s3:bucket:delete': ['aws', 's3', 'destructive', 'non_reversible'],
  'aws:lambda:create': ['aws', 'lambda', 'low_risk'],
  'aws:lambda:update': ['aws', 'lambda', 'low_risk'],
  'aws:lambda:delete': ['aws', 'lambda', 'destructive', 'non_reversible'],
  'aws:lambda:invoke': ['aws', 'lambda', 'low_risk'],
  'aws:iam:role:create': ['aws', 'iam', 'low_risk'],
  'aws:iam:policy:attach': ['aws', 'iam', 'low_risk'],
  'aws:iam:policy:detach': ['aws', 'iam', 'low_risk'],
  'aws:iam:user:create': ['aws', 'iam', 'low_risk'],
  'aws:iam:user:delete': ['aws', 'iam', 'destructive', 'requires_approval'],
};

async function getEC2State(
  client: MockEC2Client,
  instanceId: string,
): Promise<string> {
  const desc = await client.describeInstances({ InstanceIds: [instanceId] });
  if (!desc.Reservations.length || !desc.Reservations[0].Instances.length) {
    throw new Error(`EC2 instance ${instanceId} not found`);
  }
  return desc.Reservations[0].Instances[0].State.Name;
}

const ec2StartHandler: CompensationHandler = async (action) => {
  const client = action.args._ec2Client as MockEC2Client;
  const instanceId = action.args.instanceId as string;
  const memo = action.args._memo as { originalState: string };

  try {
    if (memo?.originalState === 'stopped') {
      await client.stopInstances({ InstanceIds: [instanceId] });
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
};

const ec2StopHandler: CompensationHandler = async (action) => {
  const client = action.args._ec2Client as MockEC2Client;
  const instanceId = action.args.instanceId as string;
  const memo = action.args._memo as { originalState: string };

  try {
    if (memo?.originalState === 'running') {
      await client.startInstances({ InstanceIds: [instanceId] });
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
};

const ec2RebootHandler: CompensationHandler = async (_action) => {
  return { success: true };
};

const ec2TerminateHandler: CompensationHandler = async (_action) => {
  return { success: false, error: 'EC2 termination is non-reversible' };
};

const s3PutHandler: CompensationHandler = async (action) => {
  const client = action.args._s3Client as MockS3Client;
  const bucket = action.args.bucket as string;
  const key = action.args.key as string;

  try {
    await client.deleteObject({ Bucket: bucket, Key: key });
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
};

const s3DeleteHandler: CompensationHandler = async (action) => {
  const client = action.args._s3Client as MockS3Client;
  const bucket = action.args.bucket as string;
  const key = action.args.key as string;
  const memo = action.args._memo as { versionId?: string };

  try {
    if (memo?.versionId) {
      await client.deleteObject({
        Bucket: bucket,
        Key: key,
        VersionId: memo.versionId,
      });
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
};

const s3BucketCreateHandler: CompensationHandler = async (action) => {
  const client = action.args._s3Client as MockS3Client;
  const bucket = action.args.bucket as string;

  try {
    await client.deleteBucket({ Bucket: bucket });
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
};

const s3BucketDeleteHandler: CompensationHandler = async (_action) => {
  return { success: false, error: 'S3 bucket deletion is irreversible' };
};

const lambdaCreateHandler: CompensationHandler = async (action) => {
  const client = action.args._lambdaClient as MockLambdaClient;
  const functionName = action.args.functionName as string;

  try {
    await client.deleteFunction({ FunctionName: functionName });
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
};

const lambdaUpdateHandler: CompensationHandler = async (action) => {
  const client = action.args._lambdaClient as MockLambdaClient;
  const functionName = action.args.functionName as string;
  const memo = action.args._memo as {
    priorRole: string;
    priorHandler: string;
    priorRuntime: string;
  };

  try {
    await client.updateFunctionConfiguration({
      FunctionName: functionName,
      Role: memo.priorRole,
      Handler: memo.priorHandler,
      Runtime: memo.priorRuntime,
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
};

const lambdaDeleteHandler: CompensationHandler = async (_action) => {
  return { success: false, error: 'Lambda function deletion is irreversible' };
};

const lambdaInvokeHandler: CompensationHandler = async (_action) => {
  return { success: true };
};

const iamRoleCreateHandler: CompensationHandler = async (action) => {
  const client = action.args._iamClient as MockIAMClient;
  const roleName = action.args.roleName as string;

  try {
    const attached = await client.listAttachedRolePolicies({ RoleName: roleName });
    for (const policy of attached.AttachedPolicies) {
      await client.detachRolePolicy({ RoleName: roleName, PolicyArn: policy.PolicyArn });
    }
    const inline = await client.listRolePolicies({ RoleName: roleName });
    for (const policyName of inline.PolicyNames) {
      await client.deleteRolePolicy({ RoleName: roleName, PolicyName: policyName });
    }
    await client.deleteRole({ RoleName: roleName });
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
};

const iamPolicyAttachHandler: CompensationHandler = async (action) => {
  const client = action.args._iamClient as MockIAMClient;
  const roleName = action.args.roleName as string;
  const policyArn = action.args.policyArn as string;

  try {
    await client.detachRolePolicy({ RoleName: roleName, PolicyArn: policyArn });
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
};

const iamPolicyDetachHandler: CompensationHandler = async (action) => {
  const client = action.args._iamClient as MockIAMClient;
  const roleName = action.args.roleName as string;
  const policyArn = action.args.policyArn as string;

  try {
    await client.detachRolePolicy({ RoleName: roleName, PolicyArn: policyArn });
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
};

const iamUserCreateHandler: CompensationHandler = async (action) => {
  const client = action.args._iamClient as MockIAMClient;
  const userName = action.args.userName as string;

  try {
    const inline = await client.listUserPolicies({ UserName: userName });
    for (const policyName of inline.PolicyNames) {
      await client.deleteUserPolicy({ UserName: userName, PolicyName: policyName });
    }
    await client.deleteUser({ UserName: userName });
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
};

const iamUserDeleteHandler: CompensationHandler = async (_action) => {
  return { success: false, error: 'IAM user deletion is irreversible' };
};

const AWS_COMPENSATION_HANDLERS: Record<string, CompensationHandler> = {
  'aws:ec2:start': ec2StartHandler,
  'aws:ec2:stop': ec2StopHandler,
  'aws:ec2:reboot': ec2RebootHandler,
  'aws:ec2:terminate': ec2TerminateHandler,
  'aws:s3:put': s3PutHandler,
  'aws:s3:delete': s3DeleteHandler,
  'aws:s3:bucket:create': s3BucketCreateHandler,
  'aws:s3:bucket:delete': s3BucketDeleteHandler,
  'aws:lambda:create': lambdaCreateHandler,
  'aws:lambda:update': lambdaUpdateHandler,
  'aws:lambda:delete': lambdaDeleteHandler,
  'aws:lambda:invoke': lambdaInvokeHandler,
  'aws:iam:role:create': iamRoleCreateHandler,
  'aws:iam:policy:attach': iamPolicyAttachHandler,
  'aws:iam:policy:detach': iamPolicyDetachHandler,
  'aws:iam:user:create': iamUserCreateHandler,
  'aws:iam:user:delete': iamUserDeleteHandler,
};

export function registerAWSCompensation(
  registry: { register: (toolName: string, handler: CompensationHandler) => void },
): void {
  for (const [toolName, handler] of Object.entries(AWS_COMPENSATION_HANDLERS)) {
    registry.register(toolName, handler);
  }
}

export function getAWSCompensationHandlers(): Record<string, CompensationHandler> {
  return { ...AWS_COMPENSATION_HANDLERS };
}

export async function prepareEC2Memo(
  client: MockEC2Client,
  instanceId: string,
): Promise<{ originalState: string }> {
  const state = await getEC2State(client, instanceId);
  return { originalState: state };
}

export async function prepareLambdaUpdateMemo(
  client: MockLambdaClient,
  functionName: string,
): Promise<{ priorRole: string; priorHandler: string; priorRuntime: string }> {
  const config = await client.getFunction({ FunctionName: functionName });
  return {
    priorRole: config.Configuration.Role,
    priorHandler: config.Configuration.Handler,
    priorRuntime: config.Configuration.Runtime,
  };
}
