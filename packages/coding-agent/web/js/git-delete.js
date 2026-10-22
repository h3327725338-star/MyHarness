// Shared presentation of branch/copy deletion failures. It never runs Git or retries a deletion automatically.
import { t } from "./i18n.js";

/** Match the original cause, including new/old Git wording, and keep unknown errors in a separate details view. */
export function explainDeleteFailure(error, kind, force = false) {
	const detail = error.detail;
	// Branch names and paths are data, not causes (a copy can legitimately be named "not trusted" or "locked").
	const text = detail.replace(/'[^'\r\n]*'|"[^"\r\n]*"/g, "");
	// Server-side trust/busy guards take precedence over keywords in the error or target path.
	if (error.status === 403 || /not trusted|\u672a\u4fe1\u4efb/i.test(text))
		return { message: t("This project has not been allowed to make changes. Open Settings, then Safety & privacy, turn on Trust this project in the Project trust section, and return here to retry the deletion.") };
	if (error.status === 409 || /task is running|\u4f1a\u8bdd\u6b63\u5728\u8fd0\u884c|Git operation is already in progress/i.test(text))
		return { message: t("A task or Git operation is still running. Wait for it to finish, or stop the task, then click 'Retry delete'.") };
	// New Git also uses this wording for the current branch; keep the old wording as a compatibility match.
	if (kind === "branch" && /used by worktree|checked out at/i.test(text)) {
		return {
			canForce: true,
			occupied: true,
			message: t("This branch is used by an isolated copy. Force deletion will also destroy its Worktree copies and permanently discard all uncommitted changes inside them."),
			worktreePath: /(?:used by worktree|checked out) at ['"](.+)['"]/i.exec(detail)?.[1],
		};
	}
	if (/current.*Worktree|worktree in use cannot|main worktree cannot be deleted|\u5f53\u524d\u6b63\u5728\u4f7f\u7528|main \u4e3b Worktree/i.test(text))
		return { message: t("The main copy or the copy used by this chat cannot be deleted here. Return to the main copy before deleting another copy; the main copy itself must be kept.") };
	if (/Unknown worktree|does not exist|no longer exists|\u5df2\u4e0d\u5b58\u5728|\u5206\u652f.*\u4e0d\u5b58\u5728/i.test(text))
		return { message: t("The selected branch or copy is no longer in the repository. Cancel, close and reopen this menu to refresh the list.") };
	if (/\bis (?:a )?locked\b|cannot lock ref|Permission denied|access.*denied|unable to unlink|EBUSY|EPERM|\u62d2\u7edd\u8bbf\u95ee/i.test(text))
		return { message: t("The branch or copy is locked, or a file cannot be changed. Close programs using it and check your access permissions, then click 'Retry delete'. See 'Error details' for the affected file.") };
	if (/Cannot reach the MyHarness server|\u65e0\u6cd5\u8fde\u63a5.*\u670d\u52a1/i.test(text))
		return { message: t("The local service could not be reached, so deletion was not confirmed. Reconnect or restart MyHarness, reopen this menu to check the list, then retry if the item is still there.") };
	if (kind === "branch" && /not fully merged/i.test(text))
		return { canForce: true, message: t("Safe deletion was refused because this branch has unmerged commits. If you no longer need them, click 'Force delete branch'. Otherwise, click Cancel.") };
	if (kind === "copy" && /modified or untracked|use --force/i.test(text))
		return { canForce: true, message: force
			? t("Force deletion of the copy did not complete. Check 'Error details', resolve the problem, then try again; click Cancel to keep the copy.")
			: t("Safe deletion was refused because the copy has changes or new files that have not been committed. Click 'Force delete copy' to discard them, or Cancel to keep them.") };
	return { message: t("Deletion did not complete and the exact cause could not be identified. Open 'Error details', resolve the reported problem, then click 'Retry delete'; or Cancel to leave it as it is.") };
}
