// The recovered Harness can leave a rejected model-stream branch unobserved
// after it has already turned the same failure into the current turn result.
function modelFailureDetails(reason) {
  for (let current = reason, depth = 0; current && depth < 5; current = current.cause, depth++) {
    if (current?.name === 'ModelRequestError') {
      return { name: current.name, status: current.status, code: current.code };
    }
  }
  return undefined;
}

export function isContainedModelRejection(reason) {
  return modelFailureDetails(reason) !== undefined;
}

export function installModelRejectionGuard(target = process) {
  target.on('unhandledRejection', reason => {
    const failure = modelFailureDetails(reason);
    if (failure) {
      // The request has its own error path; never include provider text or credentials in process logs.
      console.error(`[local-host] contained unhandled model rejection ${JSON.stringify(failure)}`);
      return;
    }
    // Attaching this listener changes Node's default rejection policy, so preserve it for unrelated defects.
    throw reason;
  });
}
