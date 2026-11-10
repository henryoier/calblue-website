// Node CI: node tests/test_pages_artifact_wait.js
// macOS without Node: osascript -l JavaScript tests/test_pages_artifact_wait.js
// Every request, delay and artifact is injected; no network or deployment runs.
async function pagesArtifactTests(waitForPagesArtifact) {
  const results = [];
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const expectedId = 13592676263;
  const runId = 42418307332;
  const artifact = changes => ({ id: expectedId, name: 'github-pages', expired: false,
    size_in_bytes: 20088004, workflow_run: { id: runId }, ...changes });
  const listed = artifacts => ({ status: 200, data: { artifacts } });
  const fixture = sequence => {
    const requests = [], delays = [], messages = [];
    const queue = sequence.slice();
    const input = {
      github: { rest: { actions: { listWorkflowRunArtifacts: async request => {
        requests.push(request);
        assert(queue.length > 0, 'An unexpected API request was made');
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next;
      } } } },
      core: { info: message => messages.push(message) },
      context: { repo: { owner: 'henryoier', repo: 'calblue-website' }, runId },
      listInternalArtifacts: async () => [artifact()],
      expectedArtifactId: String(expectedId), sleep: async delay => delays.push(delay),
    };
    return { input, requests, delays, messages };
  };
  const rejects = async (input, phrase) => {
    let failure;
    try { await waitForPagesArtifact(input); } catch (error) { failure = error; }
    assert(failure instanceof Error, 'Expected a safe failure');
    assert(failure.message.includes(phrase), 'Failure did not explain the relevant boundary');
    assert(!failure.message.includes('PRIVATE_TOKEN'), 'Provider details must not escape');
    return failure;
  };
  const test = async (name, body) => {
    const record = { name, error: null };
    try { await body(); } catch (error) { record.error = error.message; }
    results.push(record);
  };

  await test('Upload missing from the first listing becomes visible before deployment', async () => {
    const f = fixture([listed([]), listed([artifact()])]);
    const ready = await waitForPagesArtifact(f.input);
    assert(ready.id === expectedId && ready.name === 'github-pages', 'Expected the exact uploaded artifact');
    assert(f.requests.length === 2 && f.delays.join() === '5000', 'Poll only until the artifact is visible');
    for (const request of f.requests) {
      assert(request.owner === 'henryoier' && request.repo === 'calblue-website'
        && request.run_id === runId && request.page === 1 && request.per_page === 100,
      'Metadata must be scoped to the current repository and workflow run');
      assert(request.request.timeout === 10000, 'API requests need a timeout');
    }
  });
  await test('An already visible upload needs no delay or second request', async () => {
    const f = fixture([listed([artifact()])]);
    await waitForPagesArtifact(f.input);
    assert(f.requests.length === 1 && f.delays.length === 0, 'Stop on the first valid response');
  });
  await test('Unrelated artifacts do not substitute for the new upload', async () => {
    const f = fixture([listed([artifact({ id: 1, name: 'diagnostics' })]), listed([artifact()])]);
    await waitForPagesArtifact(f.input);
    assert(f.requests.length === 2, 'Wait for the expected upload ID');
  });
  await test('Invalid upload IDs or workflow context fail before requesting metadata', async () => {
    for (const invalid of ['', '0', '1e3', 'PRIVATE_TOKEN', 0, true, null, Number.MAX_SAFE_INTEGER + 1]) {
      const f = fixture([]); f.input.expectedArtifactId = invalid;
      await rejects(f.input, 'valid upload ID');
      assert(f.requests.length === 0, 'Invalid IDs must not make requests');
    }
    for (const context of [{ runId: 0 }, { runId, repo: { owner: '../PRIVATE_TOKEN', repo: 'site' } },
      { runId, repo: { owner: 'owner', repo: 'site/PRIVATE_TOKEN' } }]) {
      const f = fixture([]); f.input.context = context;
      await rejects(f.input, 'valid upload ID');
      assert(f.requests.length === 0, 'Invalid context must not make requests');
    }
  });
  await test('Wrong IDs, names and duplicate Pages artifacts fail before publication', async () => {
    for (const artifacts of [[artifact({ id: 1 })], [artifact({ name: 'other' })],
      [artifact(), artifact({ id: 2 })], [artifact(), artifact()]]) {
      const f = fixture([listed(artifacts)]);
      await rejects(f.input, 'deployment was not attempted');
      assert(f.requests.length === 1 && f.delays.length === 0, 'Mismatches must not be retried');
    }
  });
  await test('Expired, empty or cross-run uploads cannot be deployed', async () => {
    for (const changes of [{ expired: true }, { expired: null }, { size_in_bytes: 0 },
      { size_in_bytes: -1 }, { workflow_run: { id: runId + 1 } }, { workflow_run: null }]) {
      const f = fixture([listed([artifact(changes)])]);
      await rejects(f.input, 'expired, empty or belongs to another run');
      assert(f.delays.length === 0, 'Invalid upload state must fail immediately');
    }
  });
  await test('Malformed API metadata cannot become a successful wait', async () => {
    for (const response of [undefined, null, {}, { status: 200, data: {} }, listed([null]),
      listed([artifact({ id: '13592676263' })]), listed([artifact({ name: null })]),
      { status: 201, data: { artifacts: [artifact()] } }]) {
      const f = fixture([response]);
      await rejects(f.input, 'metadata was invalid');
      assert(f.delays.length === 0, 'Malformed responses must fail immediately');
    }
  });
  await test('A never-visible upload stops after twelve checks and eleven short waits', async () => {
    const f = fixture(Array.from({ length: 12 }, () => listed([])));
    await rejects(f.input, 'not visible after 12 checks');
    assert(f.requests.length === 12 && f.delays.length === 11
      && f.delays.every(delay => delay === 5000), 'Bound the polling budget to fifty-five seconds of delays');
  });
  await test('Rate limits, service failures and known network failures may recover', async () => {
    for (const fields of [{ status: 429 }, { status: 503 }, { code: 'ECONNRESET' },
      { cause: { code: 'EAI_AGAIN' } }, { name: 'TimeoutError' }]) {
      const error = Object.assign(new Error('PRIVATE_TOKEN'), fields);
      const f = fixture([error, listed([artifact()])]);
      await waitForPagesArtifact(f.input);
      assert(f.requests.length === 2 && f.delays.join() === '5000', 'Retry only within the polling budget');
      assert(!f.messages.join().includes('PRIVATE_TOKEN'), 'Request errors must stay redacted');
    }
  });
  await test('Authorization and unknown client errors fail without retries or disclosure', async () => {
    for (const fields of [{ status: 401 }, { status: 403 }, { status: 404 }, {},
      { status: 403, code: 'ECONNRESET' }]) {
      const f = fixture([Object.assign(new Error('PRIVATE_TOKEN'), fields)]);
      await rejects(f.input, 'metadata request failed');
      assert(f.requests.length === 1 && f.delays.length === 0, 'Authorization failures are not transient');
      assert(!f.messages.join().includes('PRIVATE_TOKEN'), 'Logs must not expose provider messages');
    }
  });
  await test('Persistent transient failures also stop at the polling budget', async () => {
    const f = fixture(Array.from({ length: 12 }, () => Object.assign(new Error('PRIVATE_TOKEN'), { status: 502 })));
    await rejects(f.input, 'not visible after 12 checks');
    assert(f.requests.length === 12 && f.delays.length === 11, 'Service failures cannot wait forever');
  });
  await test('A returned transient HTTP status is bounded and can recover', async () => {
    const f = fixture([{ status: 503 }, { status: 429 }, listed([artifact()])]);
    await waitForPagesArtifact(f.input);
    assert(f.requests.length === 3 && f.delays.join() === '5000,5000', 'Retry transient HTTP responses only within the budget');
  });

  const backendRun = '11111111-1111-4111-8111-111111111111';
  const backendJob = '22222222-2222-4222-8222-222222222222';
  const runtimeToken = 'header.encoded_payload.signature';
  const resultsOrigin = 'https://results-receiver.actions.githubusercontent.com';
  const internalArtifact = changes => ({ name: 'github-pages', database_id: String(expectedId),
    size: '20088004', workflow_run_backend_id: backendRun, workflow_job_run_backend_id: backendJob, ...changes });
  const internalFixture = responses => {
    const requests = [], decoded = [], signals = [];
    const queue = responses.slice();
    const options = {
      env: { ACTIONS_RUNTIME_TOKEN: runtimeToken, ACTIONS_RESULTS_URL: resultsOrigin + '/path' },
      decodePayload: value => {
        decoded.push(value);
        return { scp: 'Other.Scope Actions.Results:' + backendRun + ':' + backendJob };
      },
      parseUrl: value => {
        assert(value === resultsOrigin + '/path', 'Use the provided Results service URL');
        return { protocol: 'https:', origin: resultsOrigin, username: '', password: '' };
      },
      timeoutSignal: milliseconds => { signals.push(milliseconds); return { timeout: milliseconds }; },
      fetch: async (url, request) => {
        requests.push({ url, request });
        assert(queue.length > 0, 'Unexpected internal artifact request');
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return { status: next.status ?? 200, headers: { get: () => next.contentType ?? 'application/json; charset=utf-8' },
          json: async () => next.payload };
      },
    };
    return { options, requests, decoded, signals };
  };
  const factoryRejects = options => {
    let error;
    try { waitForPagesArtifact.createInternalArtifactLister(options); } catch (caught) { error = caught; }
    assert(error instanceof Error && error.message.includes('configuration'), 'Invalid runtime configuration must fail safely');
    assert(!error.message.includes(runtimeToken), 'Configuration errors must not disclose runtime credentials');
  };

  await test('REST visibility does not bypass the empty internal deployment listing', async () => {
    const internal = internalFixture([{ payload: { artifacts: [] } }, { payload: { artifacts: [internalArtifact()] } }]);
    const f = fixture([listed([artifact()]), listed([artifact()])]);
    f.input.listInternalArtifacts = waitForPagesArtifact.createInternalArtifactLister(internal.options);
    const ready = await waitForPagesArtifact(f.input);
    assert(ready.id === expectedId && f.delays.join() === '5000'
      && internal.requests.length === 2 && f.requests.length === 2,
    'Wait for the same internal view used by deploy-pages, even when REST was already ready');
    assert(internal.decoded.join() === 'encoded_payload', 'Decode only the runtime JWT payload once');
    for (const { url, request } of internal.requests) {
      assert(url === resultsOrigin + '/twirp/github.actions.results.api.v1.ArtifactService/ListArtifacts',
        'Use the official internal ListArtifacts endpoint');
      assert(request.method === 'POST' && request.redirect === 'error', 'Listing requests must not follow redirects');
      assert(request.headers.Authorization === 'Bearer ' + runtimeToken
        && request.headers['Content-Type'] === 'application/json', 'Authenticate with the Actions runtime token');
      const body = JSON.parse(request.body);
      assert(Object.keys(body).sort().join() === 'workflow_job_run_backend_id,workflow_run_backend_id'
        && body.workflow_run_backend_id === backendRun && body.workflow_job_run_backend_id === backendJob,
      'Serialize exactly the official protobuf snake_case scope fields');
      assert(request.signal.timeout === 10000, 'Bound internal requests with an abort signal');
    }
    assert(!f.messages.join().includes(runtimeToken), 'Artifact visibility logs must not disclose credentials');
  });
  await test('Internal metadata accepts the documented protobuf casing variants', async () => {
    const internal = internalFixture([{ payload: { artifacts: [{ name: 'github-pages', databaseId: String(expectedId),
      size: '20088004', workflowRunBackendId: backendRun, workflowJobRunBackendId: backendJob }] } }]);
    const reader = waitForPagesArtifact.createInternalArtifactLister(internal.options);
    const rows = await reader();
    assert(rows.length === 1 && rows[0].id === expectedId && rows[0].size_in_bytes === 20088004,
      'Convert protobuf uint64 strings without rounding');
  });
  await test('Runtime credentials, backend scopes and HTTPS origin are validated before requests', async () => {
    for (const env of [{}, { ACTIONS_RUNTIME_TOKEN: runtimeToken },
      { ACTIONS_RUNTIME_TOKEN: 'PRIVATE_TOKEN\nheader', ACTIONS_RESULTS_URL: resultsOrigin }]) {
      const internal = internalFixture([]); internal.options.env = env;
      factoryRejects(internal.options);
      assert(internal.requests.length === 0, 'Malformed runtime configuration must not make requests');
    }
    for (const scp of [null, [], 'Other.Scope', 'Actions.Results:bad:scope',
      'Actions.Results:' + backendRun + ':' + backendJob + ' Actions.Results:' + backendRun + ':' + backendJob]) {
      const internal = internalFixture([]); internal.options.decodePayload = () => ({ scp });
      factoryRejects(internal.options);
    }
    for (const parsed of [{ protocol: 'http:', origin: 'http://example.test' },
      { protocol: 'https:', origin: resultsOrigin, username: 'user', password: '' },
      { protocol: 'https:', origin: resultsOrigin, username: '', password: 'PRIVATE_TOKEN' }]) {
      const internal = internalFixture([]); internal.options.parseUrl = () => parsed;
      factoryRejects(internal.options);
    }
    const f = fixture([]); f.input.listInternalArtifacts = null;
    await rejects(f.input, 'valid upload ID');
    assert(f.requests.length === 0, 'An internal listing callback is required; REST-only waits are disallowed');
  });
  await test('Internal transient failures recover without exposing the runtime token', async () => {
    const internal = internalFixture([{ status: 503 }, { payload: { artifacts: [internalArtifact()] } }]);
    const f = fixture([listed([artifact()]), listed([artifact()])]);
    f.input.listInternalArtifacts = waitForPagesArtifact.createInternalArtifactLister(internal.options);
    await waitForPagesArtifact(f.input);
    assert(internal.requests.length === 2 && f.delays.join() === '5000', 'Retry transient internal service responses');
    assert(!f.messages.join().includes(runtimeToken), 'Internal retry logs must keep credentials private');
  });
  await test('Internal authorization failures are terminal and their bodies are not logged', async () => {
    const internal = internalFixture([{ status: 403, payload: { msg: 'PRIVATE_TOKEN' } }]);
    const f = fixture([listed([artifact()])]);
    f.input.listInternalArtifacts = waitForPagesArtifact.createInternalArtifactLister(internal.options);
    await rejects(f.input, 'metadata request failed');
    assert(f.delays.length === 0 && internal.requests.length === 1, 'Internal permission failures must stop publication');
    assert(!f.messages.join().includes('PRIVATE_TOKEN'), 'Twirp error messages must not reach logs');
  });
  await test('Malformed and cross-scope internal records fail before publication', async () => {
    for (const raw of [internalArtifact({ workflow_run_backend_id: backendJob }),
      internalArtifact({ workflow_job_run_backend_id: backendRun }),
      internalArtifact({ databaseId: '1' }), internalArtifact({ size: '9007199254740993' })]) {
      const internal = internalFixture([{ payload: { artifacts: [raw] } }]);
      const f = fixture([listed([artifact()])]);
      f.input.listInternalArtifacts = waitForPagesArtifact.createInternalArtifactLister(internal.options);
      await rejects(f.input, 'metadata request failed');
      assert(f.delays.length === 0, 'Wrong internal scope or ambiguous uint64 data must not be retried');
    }
    for (const rows of [[{ id: 1, name: 'github-pages', size_in_bytes: 1 }],
      [{ id: expectedId, name: 'other', size_in_bytes: 1 }],
      [{ id: expectedId, name: 'github-pages', size_in_bytes: -1 }]]) {
      const f = fixture([listed([artifact()])]); f.input.listInternalArtifacts = async () => rows;
      await rejects(f.input, 'deployment was not attempted');
      assert(f.delays.length === 0, 'A different internal artifact cannot substitute for the upload');
    }
  });
  await test('Internal visibility remains bounded when REST is permanently ready', async () => {
    const f = fixture(Array.from({ length: 12 }, () => listed([artifact()])));
    let internalCalls = 0;
    f.input.listInternalArtifacts = async () => { internalCalls += 1; return []; };
    await rejects(f.input, 'not visible after 12 checks');
    assert(internalCalls === 12 && f.delays.length === 11, 'Do not publish on REST visibility alone after exhausting retries');
  });
  await test('An omitted protobuf artifacts field retries until the internal upload is visible', async () => {
    const internal = internalFixture([{ payload: {} }, { payload: { artifacts: [internalArtifact()] } }]);
    const f = fixture([listed([artifact()]), listed([artifact()])]);
    f.input.listInternalArtifacts = waitForPagesArtifact.createInternalArtifactLister(internal.options);
    await waitForPagesArtifact(f.input);
    assert(internal.requests.length === 2 && f.delays.join() === '5000',
      'Normalize the official protobuf empty response without skipping the visibility gate');
    for (const payload of [null, [], true, 'unexpected', { artifacts: null }, { artifacts: {} }, { artifacts: undefined }]) {
      const invalid = internalFixture([{ payload }]);
      const rejected = fixture([listed([artifact()])]);
      rejected.input.listInternalArtifacts = waitForPagesArtifact.createInternalArtifactLister(invalid.options);
      await rejects(rejected.input, 'metadata request failed');
      assert(rejected.delays.length === 0, 'Only absent repeated fields normalize; malformed protobuf payloads must fail');
    }
  });
  await test('A missing internal protobuf size is accepted only after REST proves a nonempty upload', async () => {
    const raw = internalArtifact(); delete raw.size;
    const internal = internalFixture([{ payload: { artifacts: [raw] } }]);
    const f = fixture([listed([artifact()])]);
    f.input.listInternalArtifacts = waitForPagesArtifact.createInternalArtifactLister(internal.options);
    const ready = await waitForPagesArtifact(f.input);
    assert(ready.id === expectedId && f.delays.length === 0,
      'Internal default size must not override validated positive REST ZIP metadata');
  });
  return results;
}

function pagesArtifactReport(records) {
  const failed = records.filter(record => record.error);
  if (failed.length) throw new Error(failed.map(record => record.name + ': ' + record.error).join('\n'));
  return 'Pages artifact visibility checks passed: ' + records.length + '/' + records.length + '.';
}

if (typeof require === 'function') {
  pagesArtifactTests(require('../.github/scripts/wait-for-pages-artifact.cjs'))
    .then(records => console.log(pagesArtifactReport(records)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

// Isolate native Promises in a JSContext, then drain microtasks between calls.
function run(argv) {
  ObjC.import('Foundation');
  ObjC.import('JavaScriptCore');
  const root = argv[0] || ObjC.unwrap($.NSFileManager.defaultManager.currentDirectoryPath);
  const path = root + '/.github/scripts/wait-for-pages-artifact.cjs';
  const text = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
  if (ObjC.unwrap(text) === undefined) throw new Error('Unable to read artifact wait helper');
  const context = $.JSContext.alloc.init;
  const evaluate = source => {
    const result = context.evaluateScript(source);
    if (ObjC.unwrap(context.exception) !== undefined) {
      throw new Error(ObjC.unwrap(context.exception.valueForProperty('message').toObject));
    }
    return result;
  };
  evaluate('var module = { exports: {} };\n' + ObjC.unwrap(text));
  evaluate('var records, failure, done = false; (' + pagesArtifactTests.toString()
    + ')(module.exports).then(value => { records = value; done = true; }, error => { failure = error.message; done = true; });');
  for (let turn = 0; !evaluate('done').toBool && turn < 100; turn += 1) evaluate('void 0;');
  if (!evaluate('done').toBool) throw new Error('Artifact wait tests did not settle');
  const failure = ObjC.unwrap(evaluate('failure').toObject);
  if (failure !== undefined) throw new Error(failure);
  return pagesArtifactReport(JSON.parse(ObjC.unwrap(evaluate('JSON.stringify(records)').toObject)));
}
