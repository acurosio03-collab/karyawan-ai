'use strict';
// Alur kerja standar: OWNER -> AI CEO -> AI MANAGER -> AI WORKER -> QUALITY CHECKER -> OWNER
module.exports = {
  name: 'owner-ceo-manager-worker-qa-owner',
  limits: { maxDepth: 3, maxSubtasksPerDelegation: 8, maxTasksPerGoal: 30, maxRevisions: 1, maxToolCallsPerRun: 5, maxStepsPerRun: 7 },
  // Peran yang boleh didelegasi oleh peran tertentu
  delegation: { ceo: 'any', manager: 'non-ceo' },
  qaRequiredFor: ['work-leaf', 'goal-root'],
  ownerFinalStatus: 'review'
};
