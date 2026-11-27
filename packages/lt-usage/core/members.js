export function foldMembers(records) {
  const members = new Map();
  for (const record of records ?? []) {
    const childId = record?.childId;
    if (!childId) continue;
    if (record.type === 'member') {
      members.set(childId, {
        ...record,
        status: 'starting',
        actorRole: record.actorRole ?? 'member'
      });
      continue;
    }
    const current = members.get(childId) ?? {
      childId,
      status: 'starting',
      actorRole: 'member'
    };
    if (record.type === 'member-status') {
      current.status = record.status;
      if (record.error !== undefined) current.error = record.error;
      if (record.failure !== undefined) current.failure = record.failure;
    } else {
      Object.assign(current, record);
    }
    members.set(childId, current);
  }
  return members;
}