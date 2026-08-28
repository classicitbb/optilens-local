function shouldReleaseScheduledUpdate(scheduledUpdate, requestedAt, updateRun) {
  return Boolean(
    scheduledUpdate
    && scheduledUpdate.requestedAt === requestedAt
    && !updateRun
  );
}

module.exports = { shouldReleaseScheduledUpdate };
