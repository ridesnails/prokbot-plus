import { check } from '../server/security.mjs';

const AGENT_ID = /^[a-f0-9-]{1,128}$/i;
// The runner requires a nonempty prompt before it asks promptGlue for an action.
// The replacement below discards this value and emits only summarizeAction.
const MANUAL_SUMMARY_PROMPT = 'Local administrator requested a conversation summary.';

function unsupported(value, message) {
  check(value, 501, message);
  return value;
}

function isRunning(lifecycle, session, agentId) {
  return lifecycle.inFlightRunCounts?.has(session) || lifecycle.runningAgentIds?.().has(agentId);
}

/**
 * Run the Harness' native summarizeAction for one idle Bot. This preserves the
 * original transcript and lets the normal summary handler persist its checkpoint.
 */
export async function summarizeAgent(host, _library, agentId) {
  check(typeof agentId === 'string' && AGENT_ID.test(agentId), 400, 'Bot ID 无效');
  const transcript = host?.transcript;
  unsupported(transcript?.listAgentsSync && transcript?.sessions?.resolveBackgroundSession,
    '当前 Host 版本不支持手动压缩');
  const agent = transcript.listAgentsSync().find(item => item.id === agentId);
  check(agent, 404, 'Bot 不存在');
  check(!agent.isGroup, 400, '暂不支持压缩群组 Bot');

  const lifecycle = transcript.runLifecycle, registry = transcript.runnerRegistry;
  unsupported(lifecycle?.beginSessionRun && lifecycle?.endSessionRun && lifecycle?.enqueueExclusiveRun && registry?.getRunner,
    '当前 Host 版本不支持手动压缩');
  // Resolve without activating the Bot in the currently selected client session.
  const session = await transcript.sessions.resolveBackgroundSession(agentId);
  check(!isRunning(lifecycle, session, agentId), 409, 'Bot 正在运行，请在任务结束后再压缩');
  const runner = registry.getRunner(session);
  const promptGlue = runner?.promptGlue;
  unsupported(typeof promptGlue?.assembleTurnAction === 'function' && typeof runner?.run === 'function',
    '当前 Host 版本不支持手动压缩');

  let began = false;
  try {
    // Mark the turn synchronously before queueing it, so a newly sent user
    // message is placed after this isolated summary turn instead of racing it.
    lifecycle.beginSessionRun(session);
    began = true;
    await lifecycle.enqueueExclusiveRun(agentId, async () => {
      const original = promptGlue.assembleTurnAction;
      const assembleSummaryAction = async () => ({
        // The public Host library does not export its generated proto classes.
        // The runner immediately redacts this shape and the summarize handler
        // deliberately ignores the empty action payload.
        action: { action: { case: 'summarizeAction', value: {} } },
      });
      promptGlue.assembleTurnAction = assembleSummaryAction;
      try {
        const result = await runner.run(MANUAL_SUMMARY_PROMPT, {
          hidden: true,
          requestSource: 'event',
          advanceChainOnDelivery: false,
        });
        check(!result?.aborted && !result?.pausedForUpgrade, 409, '上下文压缩被中断，请稍后重试');
      } finally {
        // Do not overwrite a newer replacement if a future Harness version
        // changes the glue while this run is completing.
        if (promptGlue.assembleTurnAction === assembleSummaryAction) promptGlue.assembleTurnAction = original;
      }
    }, { lane: 'background', source: 'manual-summary' });
    return { ok: true, agentId, status: 'completed' };
  } finally {
    if (began) lifecycle.endSessionRun(session);
    await transcript.roster?.emitAgentUpdate?.(agentId);
  }
}
