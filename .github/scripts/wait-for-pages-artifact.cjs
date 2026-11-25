'use strict';

// Upload finalization and artifact discovery can briefly disagree. deploy-pages
// uses the internal Actions Results (Twirp) listing, so REST visibility alone is
// insufficient. Verify both listings before publication.
const ATTEMPTS = 12;
const INTERVAL_MS = 5000;
const REQUEST_TIMEOUT_MS = 10000;
const NAME = 'github-pages';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTERNAL_PATH = '/twirp/github.actions.results.api.v1.ArtifactService/ListArtifacts';

function positiveId(value) {
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return null;
  if (!['string', 'number'].includes(typeof value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function transient(error) {
  const status = error?.status ?? error?.response?.status;
  if (Number.isInteger(status)) return status === 429 || (status >= 500 && status <= 599);
  const code = error?.code ?? error?.cause?.code;
  return ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND',
    'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)
    || error?.name === 'TimeoutError';
}

function wireField(value, snake, camel) {
  if (value[snake] !== undefined && value[camel] !== undefined && value[snake] !== value[camel]) {
    throw new Error('Internal Pages artifact metadata contained conflicting fields.');
  }
  return value[snake] ?? value[camel];
}

function safeRequestError(error) {
  const result = new Error('Internal Pages artifact metadata request failed.');
  const status = error?.status;
  if (Number.isInteger(status) && status >= 100 && status <= 599) result.status = status;
  if (transient(error) && !Number.isInteger(status)) {
    // Preserve retry classification, never the provider's text or raw cause.
    result.name = 'TimeoutError';
  }
  return result;
}

function createInternalArtifactLister({ env = process.env, fetch = globalThis.fetch,
  decodePayload = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
  parseUrl = value => new URL(value),
  timeoutSignal = milliseconds => AbortSignal.timeout(milliseconds) } = {}) {
  let runtimeToken, origin, workflowRunBackendId, workflowJobRunBackendId;
  try {
    runtimeToken = env.ACTIONS_RUNTIME_TOKEN;
    if (typeof runtimeToken !== 'string' || runtimeToken.length > 16384
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(runtimeToken)
      || typeof env.ACTIONS_RESULTS_URL !== 'string' || env.ACTIONS_RESULTS_URL.length > 2048
      || typeof fetch !== 'function' || typeof timeoutSignal !== 'function') throw new Error();
    const claims = decodePayload(runtimeToken.split('.')[1]);
    if (typeof claims?.scp !== 'string') throw new Error();
    const scopes = claims.scp.split(/\s+/).filter(scope => scope.startsWith('Actions.Results:'));
    if (scopes.length !== 1) throw new Error();
    const parts = scopes[0].split(':');
    if (parts.length !== 3 || !GUID.test(parts[1]) || !GUID.test(parts[2])) throw new Error();
    [workflowRunBackendId, workflowJobRunBackendId] = parts.slice(1);
    const parsed = parseUrl(env.ACTIONS_RESULTS_URL);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password
      || typeof parsed.origin !== 'string' || !parsed.origin.startsWith('https://')) throw new Error();
    origin = parsed.origin;
  } catch {
    throw new Error('Internal Pages artifact configuration is unavailable or invalid.');
  }

  // This follows actions/toolkit's internal ListArtifacts protocol, including
  // protobuf snake_case field names. No create/finalize/deploy operation runs.
  return async function listInternalArtifacts() {
    let response;
    try {
      response = await fetch(origin + INTERNAL_PATH, {
        method: 'POST', redirect: 'error',
        headers: { Authorization: 'Bearer ' + runtimeToken, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ workflow_run_backend_id: workflowRunBackendId,
          workflow_job_run_backend_id: workflowJobRunBackendId }),
        signal: timeoutSignal(REQUEST_TIMEOUT_MS),
      });
    } catch (error) { throw safeRequestError(error); }
    if (response?.status !== 200) {
      throw safeRequestError({ status: response?.status });
    }
    let payload;
    try {
      const contentType = response.headers.get('Content-Type');
      if (typeof contentType !== 'string' || contentType.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error();
      payload = await response.json();
    } catch (error) {
      if (transient(error)) throw safeRequestError(error);
      throw new Error('Internal Pages artifact metadata was invalid.');
    }
    // Protobuf JSON can omit a repeated field when it is empty. The official
    // SDK normalizes an absent artifacts field to an empty listing.
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Internal Pages artifact metadata was invalid.');
    }
    const artifacts = Object.prototype.hasOwnProperty.call(payload, 'artifacts') ? payload.artifacts : [];
    if (!Array.isArray(artifacts) || artifacts.length > 1000) {
      throw new Error('Internal Pages artifact metadata was invalid.');
    }
    return artifacts.map(artifact => {
      if (!artifact || typeof artifact !== 'object' || typeof artifact.name !== 'string') {
        throw new Error('Internal Pages artifact metadata was invalid.');
      }
      const id = positiveId(wireField(artifact, 'database_id', 'databaseId'));
      const rawSize = artifact.size ?? 0; // Protobuf may omit its default zero.
      const size = typeof rawSize === 'string' && /^\d+$/.test(rawSize) ? Number(rawSize) : rawSize;
      const run = wireField(artifact, 'workflow_run_backend_id', 'workflowRunBackendId');
      const job = wireField(artifact, 'workflow_job_run_backend_id', 'workflowJobRunBackendId');
      if (!id || !Number.isSafeInteger(size) || size < 0
        || (run !== undefined && run !== workflowRunBackendId)
        || (job !== undefined && job !== workflowJobRunBackendId)) {
        throw new Error('Internal Pages artifact metadata did not match the current workflow scope.');
      }
      return { id, name: artifact.name, size_in_bytes: size };
    });
  };
}

function matchingArtifact(artifacts, artifactId, { internal = false, runId } = {}) {
  if (!Array.isArray(artifacts) || artifacts.length > (internal ? 1000 : 100)
    || artifacts.some(artifact => !artifact || typeof artifact !== 'object'
      || positiveId(artifact.id) !== artifact.id || typeof artifact.name !== 'string')
    || new Set(artifacts.map(artifact => artifact.id)).size !== artifacts.length) {
    throw new Error('Pages artifact metadata was invalid; deployment was not attempted.');
  }
  const matches = artifacts.filter(artifact => artifact.id === artifactId);
  const named = artifacts.filter(artifact => artifact.name === NAME);
  if (named.length > 1 || (named.length === 1 && named[0].id !== artifactId)
    || (matches.length === 1 && matches[0].name !== NAME)) {
    throw new Error('Pages artifact metadata does not match the new upload; deployment was not attempted.');
  }
  if (!matches.length) return null;
  const artifact = matches[0];
  if ((!internal && artifact.expired !== false) || (internal && artifact.expired === true)
    // REST already proves that the uploaded ZIP is nonempty. The internal SDK
    // permits a default/missing size, while still requiring its exact ID/name.
    || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < (internal ? 0 : 1)
    || (!internal && artifact.workflow_run !== undefined && positiveId(artifact.workflow_run?.id) !== runId)) {
    throw new Error('Pages artifact is expired, empty or belongs to another run; deployment was not attempted.');
  }
  return artifact;
}

module.exports = async function waitForPagesArtifact({ github, core, context, expectedArtifactId,
  listInternalArtifacts,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
  const artifactId = positiveId(expectedArtifactId);
  const runId = positiveId(context?.runId);
  const owner = context?.repo?.owner;
  const repo = context?.repo?.repo;
  if (!artifactId || !runId || typeof owner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner)
    || typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(repo)
    || typeof github?.rest?.actions?.listWorkflowRunArtifacts !== 'function'
    || typeof core?.info !== 'function' || typeof sleep !== 'function' || typeof listInternalArtifacts !== 'function') {
    throw new Error('Pages artifact wait requires a valid upload ID and current workflow context.');
  }

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    core.info(`Checking Pages artifact ${artifactId}: attempt ${attempt}/${ATTEMPTS}.`);
    let response;
    let retryRequest = false;
    try {
      response = await github.rest.actions.listWorkflowRunArtifacts({
        owner, repo, run_id: runId, per_page: 100, page: 1,
        request: { timeout: REQUEST_TIMEOUT_MS },
      });
    } catch (error) {
      if (!transient(error)) throw new Error('Pages artifact metadata request failed; deployment was not attempted.');
      retryRequest = true;
      core.info('Pages artifact metadata request had a transient failure.');
    }

    if (!retryRequest && transient({ status: response?.status })) {
      retryRequest = true;
      core.info('Pages artifact metadata request had a transient failure.');
    }
    if (!retryRequest) {
      if (response?.status !== 200) {
        throw new Error('Pages artifact metadata was invalid; deployment was not attempted.');
      }
      const artifact = matchingArtifact(response.data?.artifacts, artifactId, { runId });
      if (artifact) {
        let internalArtifacts;
        let internalFailed = false;
        try { internalArtifacts = await listInternalArtifacts(); }
        catch (error) {
          if (!transient(error)) throw new Error('Internal Pages artifact metadata request failed; deployment was not attempted.');
          internalFailed = true;
          core.info('Internal Pages artifact metadata request had a transient failure.');
        }
        if (!internalFailed && matchingArtifact(internalArtifacts, artifactId, { internal: true })) {
          core.info(`Pages artifact ${artifactId} is visible in REST and the internal deployment listing for workflow run ${runId}.`);
          return { id: artifactId, name: NAME };
        }
      }
    }

    if (attempt < ATTEMPTS) await sleep(INTERVAL_MS);
  }
  throw new Error(`Pages artifact ${artifactId} was not visible after ${ATTEMPTS} checks; deployment was not attempted.`);
};
module.exports.createInternalArtifactLister = createInternalArtifactLister;
