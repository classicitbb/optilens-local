// Who may open and manage a mailbox. Pure so it can be unit tested.
//
// - Shared mailboxes (orders@ and the like) are open to every admin/operator.
// - Personal mailboxes are open to their members only. Admins can manage
//   (share, disconnect) any mailbox but do not read a personal one unless
//   they are added as a member.

function isMember(user, members) {
  const email = String(user?.email || "").toLowerCase();
  return Boolean(email) && members.some((member) => String(member.email).toLowerCase() === email);
}

function canAccessAccount(user, account, members = []) {
  if (!user) return false;
  if (account.is_shared === true || account.is_shared === 1) return true;
  return isMember(user, members);
}

function canManageAccount(user, account, members = []) {
  if (!user) return false;
  if (user.isAdmin) return true;
  const email = String(user.email || "").toLowerCase();
  return members.some((member) => member.role === "owner" && String(member.email).toLowerCase() === email);
}

module.exports = { canAccessAccount, canManageAccount };
