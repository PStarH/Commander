export default async function* reporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail' || event.data.todo || event.data.skip) continue;
    process.exitCode = 1;
    const data = event.data;
    const file = String(data.file ?? '').replaceAll('\\', '/');
    const relative = file.match(
      /(?:^|\/)(packages\/kernel\/src\/[a-zA-Z0-9_./-]+\.(?:ts|js))$/,
    )?.[1];
    const allowedCodes = new Set([
      'ERR_TEST_FAILURE',
      'ERR_ASSERTION',
      'ERR_MODULE_NOT_FOUND',
      'MODULE_NOT_FOUND',
      'ERR_DLOPEN_FAILED',
    ]);
    const allowedFailures = new Set([
      'testCodeFailure',
      'subtestsFailed',
      'cancelledByParent',
      'testTimeoutFailure',
      'testAborted',
      'uncaughtException',
      'unhandledRejection',
    ]);
    const error = data.details?.error;
    yield JSON.stringify({
      event: 'failure',
      file: relative && !relative.split('/').includes('..') ? relative : null,
      line: Number.isSafeInteger(data.line) ? data.line : null,
      failureType: allowedFailures.has(error?.failureType) ? error.failureType : null,
      code: allowedCodes.has(error?.code) ? error.code : null,
      causeCode: allowedCodes.has(error?.cause?.code) ? error.cause.code : null,
    }) + '\n';
  }
}
